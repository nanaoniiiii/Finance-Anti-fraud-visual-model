"""Retry DNS routes while preserving the domain, TLS SNI and CA validation.

The address cache is transient and expires; neither the board's address nor a
cloud IP is a binding credential. Event retries retain their original IDs.
"""
import http.client
import io
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse


class MaixNetwork:
    def __init__(self,ca_file=None):
        # Buildroot's system trust directory can be incomplete during early
        # boot. The packaged Mozilla roots are available with the application.
        bundle=ca_file or os.path.join(os.path.dirname(__file__),'ca-bundle.pem')
        self.context=ssl.create_default_context(cafile=bundle)
        self.lock=threading.Lock()
        self.cache={}
        self.good={}
        self.bad={}
        self.hints={}
        self._network_state = None
        self._network_checked_at = 0.0
        self._network_revision = 0

    @staticmethod
    def _route_state():
        # A UDP connect selects a local route without sending a packet.
        addresses = []
        for family, destination in ((socket.AF_INET, ("192.0.2.1", 9)),
                                    (socket.AF_INET6, ("2001:db8::1", 9))):
            try:
                with socket.socket(family, socket.SOCK_DGRAM) as route:
                    route.connect(destination)
                    addresses.append(route.getsockname()[0])
            except OSError:
                addresses.append(None)
        return tuple(addresses)

    def network_revision(self):
        now = time.monotonic()
        with self.lock:
            if now >= self._network_checked_at:
                state = self._route_state()
                self._network_checked_at = now + 1
                if self._network_state is not None and state != self._network_state:
                    self.cache.clear()
                    self.good.clear()
                    self.bad.clear()
                    self._network_revision += 1
                self._network_state = state
            return self._network_revision

    def routes(self,host,port):
        revision = self.network_revision()
        now=time.monotonic();key=(host,port)
        with self.lock:
            cached=self.cache.get(key)
            hint=self.hints.get(key)
        validated_hint=hint[1] if hint and hint[0]>time.time() else []
        if not cached or now>=cached[0]:
            try:
                addresses=list(dict.fromkeys(row[4][0]for row in socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)))
            except socket.gaierror:
                if not validated_hint:
                    raise
                addresses=[]
            addresses.sort(key=lambda value:':'in value)
            if addresses:
                with self.lock:
                    if self._network_revision == revision:
                        self.cache[key]=(now+300,addresses)
        else:addresses=list(cached[1])
        with self.lock:
            addresses=list(dict.fromkeys((*validated_hint,*addresses)))
            preferred=self.good.get(key)
            addresses.sort(key=lambda value:(self.bad.get((key,value),0)>now,value!=preferred))
        return addresses

    def failed(self,host,port,peer):
        with self.lock:
            self.bad[((host,port),peer)]=time.monotonic()+30
            self.cache.pop((host,port),None)

    def succeeded(self,host,port,peer):
        with self.lock:
            self.good[(host,port)]=peer
            self.bad.pop(((host,port),peer),None)

    def apply_hints(self, host, port, hints):
        if not isinstance(hints, dict) or hints.get("host") != host:
            return
        expiry = hints.get("expires_unix")
        if not isinstance(expiry, (int, float)) or not time.time() < expiry <= time.time() + 300:
            return
        candidates = hints.get("addresses")
        if not isinstance(candidates, list):
            return
        addresses = []
        for candidate in candidates[:4]:
            try:
                address = ipaddress.IPv4Address(candidate)
            except (ipaddress.AddressValueError, TypeError):
                continue
            if address.is_global:
                addresses.append(str(address))
        if addresses:
            with self.lock:
                self.hints[(host, port)] = (expiry, addresses)

    @staticmethod
    def address(url,scheme):
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!=scheme or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
            raise ValueError('A credential-free secure cloud URL is required')
        return parsed,parsed.hostname,parsed.port or 443

    def http_json(self,server,path,payload,token=None,timeout=12):
        parsed,host,port=self.address(server,'https')
        route=parsed.path.rstrip('/')+path
        body=json.dumps(payload,separators=(',',':')).encode('utf-8')
        headers={'Content-Type':'application/json','User-Agent':'PoseGuard-MaixCAM/1.6.0','Connection':'close'}
        if token:headers['Authorization']='Bearer '+token
        deadline=time.monotonic()+max(20,timeout*2);last=None
        for peer in self.routes(host,port):
            remaining=deadline-time.monotonic()
            if remaining<=0:break
            connection=http.client.HTTPSConnection(host,port,timeout=min(8,remaining),context=self.context)
            # HTTPSConnection still wraps this socket with server_hostname=host
            # and sends Host: host. Only the TCP destination is selected here.
            connection._create_connection=lambda address,timeout=None,source_address=None,chosen=peer:socket.create_connection((chosen,port),timeout=timeout,source_address=source_address)
            try:
                connection.request('POST',route,body=body,headers=headers)
                response=connection.getresponse();data=response.read(1024*1024+1)
                if len(data)>1024*1024:raise ValueError('Cloud response exceeds JSON limit')
                if response.status>=400:
                    raise urllib.error.HTTPError(server+path,response.status,response.reason,response.headers,io.BytesIO(data))
                result=json.loads(data)
                self.succeeded(host,port,peer)
                if isinstance(result, dict):
                    self.apply_hints(host, port, result.get("network"))
                return result
            except urllib.error.HTTPError:
                raise
            except (OSError,ssl.SSLError,http.client.HTTPException)as error:
                if last is None or ':'not in peer:last=error
                self.failed(host,port,peer)
            finally:connection.close()
        raise urllib.error.URLError(last or TimeoutError('No secure cloud route responded'))

    def open_preview(self,url,**options):
        import websocket
        _,host,port=self.address(url,'wss')
        deadline=time.monotonic()+max(20,float(options.get('timeout',8))*2);last=None
        for peer in self.routes(host,port):
            remaining=deadline-time.monotonic()
            if remaining<=0:break
            raw=None;secure=None
            try:
                raw=socket.create_connection((peer,port),timeout=min(8,remaining))
                secure=self.context.wrap_socket(raw,server_hostname=host);raw=None
                connection=websocket.create_connection(url,socket=secure,**options)
                secure=None;self.succeeded(host,port,peer)
                connection.poseguard_route = (host, port, peer)
                return connection
            except websocket.WebSocketBadStatusException:
                raise
            except (OSError,ssl.SSLError,websocket.WebSocketException)as error:
                last=error;self.failed(host,port,peer)
            finally:
                if secure:secure.close()
                if raw:raw.close()
        raise OSError('No secure preview route responded')from last

    def preview_failed(self, connection):
        route = getattr(connection, "poseguard_route", None)
        if route:
            self.failed(*route)
