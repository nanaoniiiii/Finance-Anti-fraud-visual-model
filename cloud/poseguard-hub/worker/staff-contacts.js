import {
  ApiError,
  audit,
  body,
  email,
  identifier,
  json,
  now,
  parse,
  readSetting,
  saveSetting,
  text,
  uid,
} from './utils.js';
import { rateLimit } from './auth.js';

export async function contactDirectory(env, user) {
  const contacts = (
    await env.DB.prepare(
      'SELECT id,name,email,role,areas_json FROM users ORDER BY name,id',
    ).all()
  ).results.map(({ areas_json, ...member }) => ({
    ...member,
    key: 'user:' + member.id,
    areas: parse(areas_json, []),
  }));
  const external = (
    await env.DB.prepare(
      'SELECT id,name,email,phone,area FROM staff_contacts ORDER BY created_at,id',
    ).all()
  ).results;
  const external_contacts = external
    .filter(
      (contact) =>
        !contact.email ||
        !contacts.some((member) => member.email === contact.email),
    )
    .map((contact) => ({
      ...contact,
      key: 'contact:' + contact.id,
      areas: contact.area ? [contact.area] : [],
    }));
  const defaults = await readSetting(env, 'intervention_defaults', {});
  const personal = await env.DB.prepare(
    'SELECT keys_json FROM user_contact_orders WHERE user_id=?',
  )
    .bind(user.id)
    .first();
  const all = [...contacts, ...external_contacts];
  const preferred = all.find(
    (contact) => contact.email === defaults.preferred_email,
  )?.key;
  const order = personal
    ? parse(personal.keys_json, [])
    : defaults.contact_order || [];
  const keys = [
    ...new Set([
      ...order,
      ...(preferred ? [preferred] : []),
      ...all.map((contact) => contact.key),
    ]),
  ].filter((key) => all.some((contact) => contact.key === key));
  const locations = (
    await env.DB.prepare(
      "SELECT DISTINCT location FROM devices WHERE revoked_at IS NULL AND location<>'' ORDER BY location",
    ).all()
  ).results;
  return {
    contacts,
    external_contacts,
    contact_order: keys,
    preferred_key: keys[0] || null,
    areas: [
      ...new Set([
        ...locations.map((item) => item.location),
        ...all.flatMap((item) => item.areas),
      ]),
    ].sort(),
  };
}
export async function contactRoute(request, env, user, url) {
  if (
    url.pathname === '/api/personal-messages/contacts' &&
    request.method === 'GET'
  )
    return json(await contactDirectory(env, user));
  if (
    url.pathname === '/api/personal-messages/contacts' &&
    request.method === 'POST'
  ) {
    await rateLimit(env, 'staff-contact:' + user.id, 20, 60);
    const input = await body(request, 4000),
      address = input.email ? email(input.email) : '';
    const phone = text(input.phone || '', 40).replace(/[\s()-]/g, '');
    if (phone && !/^\+?\d{5,20}$/.test(phone))
      throw new ApiError(400, '电话号码格式不正确');
    if (!address && !phone) throw new ApiError(400, '请填写邮箱或电话号码');
    if (address) {
      const member = await env.DB.prepare('SELECT id FROM users WHERE email=?')
        .bind(address)
        .first();
      if (member)
        return json({ key: 'user:' + member.id, linked_member: true });
    }
    const existing = address
      ? await env.DB.prepare('SELECT id FROM staff_contacts WHERE email=?')
          .bind(address)
          .first()
      : await env.DB.prepare('SELECT id FROM staff_contacts WHERE phone=?')
          .bind(phone)
          .first();
    if (existing)
      return json({ key: 'contact:' + existing.id, duplicate: true });
    const id = uid(),
      name = text(input.name || address || phone, 80),
      area = text(input.area || '', 80);
    await env.DB.prepare(
      'INSERT INTO staff_contacts(id,name,email,phone,area,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    )
      .bind(id, name, address, phone, area, user.id, now())
      .run();
    await audit(env, user.email, 'staff_contact_added', id);
    return json({ key: 'contact:' + id }, 201);
  }
  if (
    url.pathname === '/api/personal-messages/contact-order' &&
    request.method === 'PUT'
  ) {
    const input = await body(request, 16000);
    if (!Array.isArray(input.keys) || input.keys.length > 300)
      throw new ApiError(400, '联系人顺序不正确');
    const directory = await contactDirectory(env, user),
      valid = new Set(directory.contact_order);
    const keys = [...new Set(input.keys.map(identifier))];
    if (keys.some((key) => !valid.has(key)))
      throw new ApiError(400, '联系人列表已变化，请刷新后再排序');
    if (user.role === 'owner') {
      const previous = await readSetting(env, 'intervention_defaults', {});
      await saveSetting(env, 'intervention_defaults', {
        ...previous,
        contact_order: keys,
      });
      await env.DB.prepare('DELETE FROM user_contact_orders WHERE user_id=?')
        .bind(user.id)
        .run();
    } else
      await env.DB.prepare(
        'INSERT INTO user_contact_orders(user_id,keys_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET keys_json=excluded.keys_json,updated_at=excluded.updated_at',
      )
        .bind(user.id, JSON.stringify(keys), now())
        .run();
    return json({ contact_order: keys, preferred_key: keys[0] || null });
  }
  return null;
}
