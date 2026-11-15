// Фейковый бэкенд для проверки страницы без Apps Script и без риска для настоящих записей.
// Подменяет google.script.run; данные выдуманные, «сейчас» — 12:30 по местному времени.
// Пароль админки на стенде — «test». Задержку ответа (мс) можно задать: localStorage.mockDelay = 3000
(function () {
  const SLOTS = ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00', '20:00-22:00', '22:00-00:00'];
  const MAX = 6;
  const fmt = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  const now = new Date(), dow = now.getDay() || 7, days = [];
  for (let i = 0; i <= 7 - dow; i++) days.push(fmt(new Date(now.getTime() + i * 864e5)));
  const P = [['Смирнова Алина', '214', '@alina_sm'], ['Ким Даниил', '305', 'vk.com/dkim'], ['Орлова Вера', '118', '']];
  let rows = [], n = 0, disabled = {}, notes = {};
  // Токены на стенде живут до перезагрузки страницы; tok-keep работает всегда (проверка «запомненного» входа)
  const tokens = new Set(['tok-keep']);
  const add = (d, s, m, p) => rows.push({ id: 'r' + (n++), date: days[d], slot: SLOTS[s], machine: m, name: P[p][0], room: P[p][1], contact: P[p][2], dev: 'x' });
  add(0, 1, 1, 0); add(0, 1, 2, 0); add(0, 2, 3, 1); add(0, 4, 2, 2);
  const closed = () => SLOTS.filter(s => { const e = s.split('-')[1]; return 12 * 60 + 30 >= (e === '00:00' ? 1440 : +e.slice(0, 2) * 60); });
  // Как и настоящий API: номер комнаты наружу не отдаётся
  const st = dev => ({ today: days[0], days, slots: SLOTS, machines: 6, price: 50, maxPerDay: MAX, closed: closed(), disabled: { ...disabled }, notes: { ...notes },
    taken: rows.map(r => ({ id: r.id, date: r.date, slot: r.slot, machine: r.machine, name: r.name, contact: r.contact, mine: r.dev === dev })) });
  const api = {
    getState: dev => st(dev),
    book: req => {
      if (req.cells.some(c => String(c.machine) in disabled)) throw new Error('ERR_MACHINE_OFF');
      const per = {};
      rows.forEach(r => { if (r.dev === req.deviceId || (r.room === req.room && r.name === req.name)) per[r.date] = (per[r.date] || 0) + 1; });
      req.cells.forEach(c => { per[c.date] = (per[c.date] || 0) + 1; });
      if (req.cells.some(c => per[c.date] > MAX)) throw new Error('ERR_LIMIT');
      req.cells.forEach(c => rows.push({ id: 'r' + (n++), ...c, room: req.room, name: req.name, contact: req.contact, dev: req.deviceId }));
      return { ok: true, state: st(req.deviceId) };
    },
    cancel: (dev, id) => { rows = rows.filter(x => x.id !== id); return st(dev); },
    adminApi: req => {
      if (req.op === 'login') { if (req.password !== 'test') throw new Error('ERR_ADMIN_PASSWORD'); tokens.add('tok' + (++n)); return { token: 'tok' + n, disabled: { ...disabled }, notes: { ...notes } }; }
      if (req.op === 'logout') { tokens.delete(req.token); return { ok: true }; }
      if (!tokens.has(req.token)) throw new Error('ERR_ADMIN_TOKEN');
      if (req.op === 'setMachines') { disabled = { ...req.machines }; notes = { ...(req.notes || {}) }; }
      return { disabled: { ...disabled }, notes: { ...notes } };
    },
  };
  const delay = () => { try { return Number(localStorage.getItem('mockDelay')) || 100; } catch (e) { return 100; } };
  const runner = (ok, fail) => new Proxy({}, { get: (_, k) => k === 'withSuccessHandler' ? f => runner(f, fail) : k === 'withFailureHandler' ? f => runner(ok, f)
    : (...a) => setTimeout(() => { try { ok && ok(api[k](...a)); } catch (e) { fail && fail(e); } }, delay()) });
  window.google = { script: { run: runner(null, null) } };
})();
