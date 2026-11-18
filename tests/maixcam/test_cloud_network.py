import io
import json
import ssl
import urllib.error
from unittest.mock import patch

import pytest
from platforms.maixcam.cloud_network import MaixNetwork


def test_route_change_clears_local_dns_and_failed_peer_caches(monkeypatch):
    network = MaixNetwork()
    routes = iter([("192.168.31.114", None), ("192.168.137.108", None)])
    monkeypatch.setattr(network, "_route_state", lambda: next(routes))
    assert network.network_revision() == 0
    key = ("alerts.example.test", 443)
    network.cache[key] = (10, ["192.0.2.5"])
    network.good[key] = "192.0.2.5"
    network.bad[(key, "192.0.2.6")] = 10
    network.hints[key] = (10, ["8.8.8.8"])
    network._network_checked_at = 0
    assert network.network_revision() == 1
    assert not network.cache and not network.good and not network.bad
    assert key in network.hints


def test_failed_dns_route_retries_without_changing_tls_hostname_and_caches_good_route():
    calls=[]
    class Connection:
        def __init__(self,host,port,timeout,context):
            assert host=='alerts.example.test' and context.check_hostname
            assert context.verify_mode==ssl.CERT_REQUIRED
            self.host,self.timeout=host,timeout
        def request(self,method,path,body,headers):
            peer=self._create_connection((self.host,443),self.timeout)
            calls.append(peer)
            if peer=='198.51.100.1':raise TimeoutError('unresponsive route')
            assert method=='POST'and path=='/api/device/heartbeat'
            assert headers['Authorization']=='Bearer device-test'
        def getresponse(self):
            response=io.BytesIO(b'{"ok":true}');response.status=200;return response
        def close(self):pass
    addresses=[(2,1,6,'',(peer,443))for peer in('198.51.100.1','203.0.113.2')]
    with patch('socket.getaddrinfo',return_value=addresses),patch('socket.create_connection',side_effect=lambda address,**kw:address[0]),patch('http.client.HTTPSConnection',Connection):
        network=MaixNetwork()
        assert network.http_json('https://alerts.example.test','/api/device/heartbeat',{},'device-test')=={'ok':True}
        assert calls==['198.51.100.1','203.0.113.2']
        assert network.http_json('https://alerts.example.test','/api/device/heartbeat',{},'device-test')['ok']
        assert calls[-1]=='203.0.113.2'


def test_authoritative_auth_error_is_not_retried_at_another_address():
    calls=[]
    class Connection:
        def __init__(self,*args,**kwargs):pass
        def request(self,*args,**kwargs):calls.append(True)
        def getresponse(self):
            response=io.BytesIO(b'{"error":"revoked"}');response.status=401;response.reason='Unauthorized';response.headers={};return response
        def close(self):pass
    with patch('socket.getaddrinfo',return_value=[(2,1,6,'',('203.0.113.1',443)),(2,1,6,'',('203.0.113.2',443))]),patch('http.client.HTTPSConnection',Connection):
        with pytest.raises(urllib.error.HTTPError)as error:
            MaixNetwork().http_json('https://alerts.example.test','/api/device/heartbeat',{})
        assert error.value.code==401 and len(calls)==1


def test_preview_prepared_socket_keeps_original_sni_origin_and_verified_context():
    class Raw:
        def close(self):pass
    network=MaixNetwork();seen=[]
    class Context:
        def wrap_socket(self,raw,server_hostname):seen.append(server_hostname);return Raw()
    network.context=Context()
    class Connection:
        pass
    marker=Connection()
    def websocket(url,**kwargs):
        assert url=='wss://alerts.example.test/api/device/preview/connect'
        assert kwargs['origin']=='https://alerts.example.test' and isinstance(kwargs['socket'],Raw)
        return marker
    with patch('socket.getaddrinfo',return_value=[(2,1,6,'',('203.0.113.1',443))]),patch('socket.create_connection',return_value=Raw()),patch('websocket.create_connection',side_effect=websocket):
        assert network.open_preview('wss://alerts.example.test/api/device/preview/connect',origin='https://alerts.example.test',timeout=8)is marker
    assert seen==['alerts.example.test']


def test_cloud_routes_require_secure_urls_without_embedded_credentials():
    network=MaixNetwork()
    for url in('http://alerts.example.test','https://secret@alerts.example.test','https://alerts.example.test/#key'):
        with pytest.raises(ValueError):network.http_json(url,'/api/device/heartbeat',{})
