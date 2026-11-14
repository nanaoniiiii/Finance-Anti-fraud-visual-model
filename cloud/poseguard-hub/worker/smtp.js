import { connect } from 'cloudflare:sockets';
import { ApiError, defaultMail, decrypt, email, readSetting } from './utils.js';

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
      if (result.done) throw new Error('SMTP connection closed');
      this.buffer += new TextDecoder().decode(result.value);
      if (this.buffer.length > 65536) throw new Error('SMTP reply too large');
    }
    const cut = this.buffer.indexOf('\n');
    const line = this.buffer.slice(0, cut).replace(/\r$/, '');
    this.buffer = this.buffer.slice(cut + 1);
    return line;
  }
  async reply(wanted) {
    let line = await this.line();
    let count = 0;
    while (line[3] === '-') {
      if (++count > 100) throw new Error('SMTP reply overflow');
      line = await this.line();
    }
    const code = Number(line.slice(0, 3));
    if (!wanted.includes(code))
      throw new Error(
        code === 535
          ? 'Gmail 登录验证失败，请检查应用专用密码和登录账号'
          : `SMTP 服务拒绝请求（${code}）`
      );
    return code;
  }
  async send(value) {
    await this.writer.write(encoder.encode(value + '\r\n'));
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
      this.socket.close();
    } catch {}
  }
}
export async function sendSmtp(env, to, subject, message, id) {
  const config = { ...defaultMail, ...(await readSetting(env, 'mail', {})) };
  if (!config.enabled || !config.password_cipher)
    throw new ApiError(409, '发信账号尚未完成授权', 'mail_not_configured');
  if (
    !/^[A-Za-z0-9.-]+$/.test(config.host) ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(config.host) ||
    ![465, 587].includes(config.port)
  )
    throw new Error('SMTP 服务器设置不正确');
  const password = await decrypt(env, config.password_cipher);
  let channel;
  let timer;
  try {
    const operation = (async () => {
      let socket = connect(
        { hostname: config.host, port: config.port },
        { secureTransport: config.port === 465 ? 'on' : 'starttls' }
      );
      await socket.opened;
      channel = new SmtpChannel(socket);
      await channel.reply([220]);
      await channel.send('EHLO poseguard.nanaoni.tech');
      await channel.reply([250]);
      if (config.port === 587) {
        await channel.send('STARTTLS');
        await channel.reply([220]);
        channel.release();
        socket = socket.startTls({ expectedServerHostname: config.host });
        await socket.opened;
        channel = new SmtpChannel(socket);
        await channel.send('EHLO poseguard.nanaoni.tech');
        await channel.reply([250]);
      }
      await channel.send('AUTH LOGIN');
      await channel.reply([334]);
      await channel.send(ascii64(config.username));
      await channel.reply([334]);
      await channel.send(ascii64(password));
      await channel.reply([235]);
      await channel.send(`MAIL FROM:<${email(config.from)}>`);
      await channel.reply([250]);
      await channel.send(`RCPT TO:<${email(to)}>`);
      await channel.reply([250, 251]);
      await channel.send('DATA');
      await channel.reply([354]);
      const mime = mimeMessage({
        from: config.from,
        to,
        subject,
        text: message,
        id,
      }).replace(/(^|\r\n)\./g, '$1..');
      await channel.writer.write(encoder.encode(mime + '\r\n.\r\n'));
      await channel.reply([250]);
      try {
        await channel.send('QUIT');
      } catch {}
      return id;
    })();
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          channel?.close();
          reject(new Error('SMTP 服务响应超时'));
        }, 18000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    channel?.close();
  }
}
