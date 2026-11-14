import { ApiError, email } from './utils.js';

const encoder = new TextEncoder();
const ascii64 = (value) => btoa(String.fromCharCode(...encoder.encode(value)));
export function mimeMessage({ from, to, subject, text, id }) {
  from = email(from);
  to = email(to);
  if (/[\r\n]/.test(subject) || subject.length > 300)
    throw new Error('Invalid email subject');
  const content =
    ascii64(text)
      .match(/.{1,76}/g)
      ?.join('\r\n') || '';
  return `From: PoseGuard <${from}>\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${ascii64(subject)}?=\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${id.replace(/[^A-Za-z0-9-]/g, '')}@${from.split('@')[1]}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`;
}
class SmtpChannel {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = '';
  }
  async line() {
    while (!this.buffer.includes('\n')) {
      const result = await this.reader.read();
      if (result.done) throw new ApiError(502, 'SMTP 连接已关闭');
      this.buffer += new TextDecoder().decode(result.value);
      if (this.buffer.length > 65536) throw new ApiError(502, 'SMTP 响应过长');
    }
    const cut = this.buffer.indexOf('\n');
    const line = this.buffer.slice(0, cut).replace(/\r$/, '');
    this.buffer = this.buffer.slice(cut + 1);
    return line;
  }
  async reply(wanted) {
    const lines = [];
    let code;
    for (;;) {
      const line = await this.line();
      if (
        !/^\d{3}[ -]/.test(line) ||
        lines.length >= 100 ||
        (code && Number(line.slice(0, 3)) !== code)
      )
        throw new ApiError(502, 'SMTP 响应格式不正确');
      code = Number(line.slice(0, 3));
      lines.push(line);
      if (line[3] !== '-') break;
    }
    if (!wanted.includes(code))
      throw new ApiError(
        502,
        [530, 534, 535].includes(code)
          ? 'SMTP 登录验证失败，请检查账号、密码或授权码及服务商的 SMTP 授权设置'
          : `SMTP 服务拒绝请求（${code}）`,
        'smtp_rejected'
      );
    return { code, lines };
  }
  send(value) {
    return this.writer.write(encoder.encode(value + '\r\n'));
  }
  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
  close() {
    try {
      this.release();
    } catch {}
    try {
      this.socket.close()?.catch(() => {});
    } catch {}
  }
}
function capabilities(reply) {
  const result = new Set();
  for (const line of reply.lines) {
    const match = line.slice(4).match(/^AUTH(?:=|\s+)(.*)$/i);
    if (match)
      for (const method of match[1].trim().split(/\s+/))
        result.add(method.toLowerCase());
  }
  return result;
}
// The injected connector is Cloudflare's TLS socket API in production. Tests
// exercise the complete protocol, including a separate socket after STARTTLS.
export async function deliverSmtp(
  config,
  password,
  message,
  connectSocket,
  { timeoutMs = 18000 } = {}
) {
  let socket,
    channel,
    timer,
    cancelled = false;
  const check = () => {
    if (cancelled) throw new ApiError(504, 'SMTP 服务响应超时');
  };
  const close = () => {
    channel?.close();
    try {
      socket?.close()?.catch(() => {});
    } catch {}
  };
  try {
    const operation = (async () => {
      socket = connectSocket(
        { hostname: config.host, port: config.port },
        { secureTransport: config.security === 'tls' ? 'on' : 'starttls' }
      );
      socket.closed?.catch(() => {});
      await socket.opened;
      check();
      channel = new SmtpChannel(socket);
      await channel.reply([220]);
      await channel.send('EHLO poseguard.nanaoni.tech');
      let hello = await channel.reply([250]);
      if (config.security === 'starttls') {
        if (!hello.lines.some((line) => /^STARTTLS\b/i.test(line.slice(4))))
          throw new ApiError(
            502,
            'SMTP 服务器未提供 STARTTLS，请核对端口和加密方式'
          );
        await channel.send('STARTTLS');
        await channel.reply([220]);
        channel.release();
        socket = socket.startTls({ expectedServerHostname: config.host });
        socket.closed?.catch(() => {});
        await socket.opened;
        check();
        channel = new SmtpChannel(socket);
        await channel.send('EHLO poseguard.nanaoni.tech');
        hello = await channel.reply([250]);
      }
      const offered = capabilities(hello);
      const auth =
        config.auth === 'auto'
          ? offered.has('plain')
            ? 'plain'
            : offered.has('login')
              ? 'login'
              : ''
          : config.auth;
      if (!auth || !offered.has(auth))
        throw new ApiError(
          502,
          'SMTP 服务器不支持所选认证方式，请选择自动、LOGIN 或 PLAIN'
        );
      if (auth === 'plain') {
        const credential = ascii64('\0' + config.username + '\0' + password);
        await channel.send('AUTH PLAIN ' + credential);
        const response = await channel.reply([235, 334]);
        if (response.code === 334) {
          await channel.send(credential);
          await channel.reply([235]);
        }
      } else {
        await channel.send('AUTH LOGIN');
        await channel.reply([334]);
        await channel.send(ascii64(config.username));
        await channel.reply([334]);
        await channel.send(ascii64(password));
        await channel.reply([235]);
      }
      await channel.send(`MAIL FROM:<${email(config.from)}>`);
      await channel.reply([250]);
      await channel.send(`RCPT TO:<${email(message.to)}>`);
      await channel.reply([250, 251]);
      await channel.send('DATA');
      await channel.reply([354]);
      const mime = mimeMessage({ ...message, from: config.from }).replace(
        /(^|\r\n)\./g,
        '$1..'
      );
      await channel.writer.write(encoder.encode(mime + '\r\n.\r\n'));
      await channel.reply([250]);
      try {
        await channel.send('QUIT');
      } catch {}
      return message.id;
    })();
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancelled = true;
          close();
          reject(
            new ApiError(504, 'SMTP 服务响应超时，请核对服务器、端口和加密方式')
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    close();
  }
}
