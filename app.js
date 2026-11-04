/* Farber Fleet website.
   Every screen reads and writes through the web_* database functions in Supabase; they check that the
   signed-in person was added to Farber Fleet (and is an admin, for changes). Nothing here is secret. */
(() => {
  'use strict';
  const CFG = window.FF_CONFIG;
  const THEMES = {"clinic": "Clinic", "fog": "Morning Fog", "sandstone": "Sandstone", "sky": "Clear Sky", "sage": "Sage", "harbor": "Harbor", "citrus": "Citrus", "blush": "Blush", "glacier": "Glacier", "highway": "Highway", "midnight": "Midnight", "instrument": "Instrument", "nightshift": "Night Shift", "deepsea": "Deep Sea", "forest": "Forest Night", "plum": "Plum", "ember": "Ember", "graphite": "Graphite", "aurora": "Aurora", "radar": "Radar"};
  const ROLE_FIELDS = [
    ['sales', 'Sales'], ['electrical_engineer', 'Electrical engineer'], ['mechanical_engineer', 'Mechanical engineer'],
    ['electrical_lead', 'Electrical lead'], ['cabinetry_lead', 'Cabinetry lead'], ['purchasing', 'Purchasing coordinator'],
  ];
  const ROLE_FITS = {
    sales: (s) => s.department === 'Sales',
    electrical_engineer: (s) => s.title === 'Electrical Engineer',
    mechanical_engineer: (s) => s.title === 'Mechanical Engineer',
    electrical_lead: (s) => s.department === 'Electrical Shop',
    cabinetry_lead: (s) => s.department === 'Cabinet Shop',
    purchasing: (s) => s.department === 'Purchasing',
  };
  const TEXT_KEYS = ['name', 'company', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
    'contact_name', 'contact_title', 'contact_phone', 'contact_email'];
  const ID_OK = /^[A-Za-z0-9_-]{1,32}$/;
  const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const LOW = { chassis_v: 12.2, aux_v: 12.0, board_v: 3.5 };

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  { const rc = app.replaceChildren.bind(app); app.replaceChildren = (...kids) => rc(...kids.filter((k) => k !== null && k !== undefined && k !== false)); }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  let me = null;            // {status, email, name, role}
  let historyHours = 24;
  let renderToken = 0;      // drops results from pages the person already left
  const unsaved = { dirty: () => false };

  // ---------- small helpers
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  };
  const present = (v) => v !== null && v !== undefined && v !== '';
  const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const num = (v, d = 0) => (present(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const fmtDay = (iso) => {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const ago = (m) => (m === null || m === undefined ? 'Never reported'
    : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`);
  const mapUrl = (lat, lon) => `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
  const statusPill = (s) => h('span', { class: 'pill ' + (s === 'Online' ? 'ok' : s === 'Offline' ? 'bad' : s === 'Asleep' ? 'warn' : 'muted'), text: s, title: s === 'Asleep' ? 'Tracker’s backup battery is low; it checks in once a day until it recovers' : null });
  // tracker schedule, e.g. 600 -> "10 min"
  const fmtEvery = (sec) => !present(sec) ? null : sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${+(sec / 3600).toFixed(1)} h` : `${+(sec / 86400).toFixed(1)} day${sec === 86400 ? '' : 's'}`;
  const healthPill = (s) => h('span', { class: 'pill ' + (s === 'Good' ? 'ok' : 'warn'), text: s });
  const TYPES = { sales: 'Sales', service: 'Service', engineering: 'Engineering', customer: 'Customer' };
  // Admins can preview the site as another (staff) user type; customers have their own pages.
  let viewAs = null;
  try { viewAs = sessionStorage.getItem('ff-view-as'); } catch (e) { viewAs = null; }
  const realAdmin = () => me && me.role === 'admin';
  const isAdmin = () => realAdmin() && !viewAs;
  const isCustomer = () => me && me.user_type === 'customer';
  // Sales (or an admin viewing as Sales) sees connection status only, no network details
  const isSalesView = () => !!me && !isAdmin() && (viewAs || me.user_type) === 'sales';
  const NET_WARNINGS = ['No internet', 'On cellular with power on', 'Unusual upload volume', 'Tracker code refused'];
  // Sales sees "Tracker on backup battery" (it matters for the customer's truck); customers don't (hidden by the server)
  // Service (or an admin) gets the work-history / maintenance buttons
  const isServiceView = () => !!me && (isAdmin() || (viewAs || me.user_type) === 'service');
  // Service, Sales and admins read tickets, warnings and shocks; only Service and admins change tickets
  const canSeeTickets = () => isServiceView() || isSalesView();
  // Sales never sees network warnings
  const salesWarnings = (t) => {
    if (!isSalesView() || !t.warnings) return t;
    const w = String(t.warnings).split(', ').filter((x) => !NET_WARNINGS.includes(x)).join(', ');
    return { ...t, warnings: w || null, health: w ? 'Warning' : 'Good' };
  };
  const SERVICE_PAGES = { work: 'Maintenance history', schedule: 'Schedule maintenance', done: 'Add maintenance completed' };
  const typeLabel = (t) => TYPES[t] || 'Not set';

  const showNotice = (title, body, kind) => {
    $('notice').hidden = false;
    $('notice').className = 'notice ' + (kind || 'bad');
    $('notice-title').textContent = title;
    $('notice-body').textContent = body ? ' ' + body : '';
  };
  const hideNotice = () => { $('notice').hidden = true; };

  // Database calls: errors come back as plain sentences from the web_* functions.
  const rpc = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) {
      const e = new Error(error.message || 'Something went wrong.');
      e.code = error.code;
      throw e;
    }
    return data;
  };
  const friendly = (err) => {
    const m = (err && err.message) || '';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Can’t reach the fleet database. Check the internet connection and try again.';
    if (/JWT|token is expired/i.test(m)) return 'Your sign-in expired. Sign in again.';
    return m || 'Something went wrong.';
  };

  // ---------- themes
  const applyTheme = (id, remember) => {
    const t = THEMES[id] ? id : 'auto';
    const root = document.documentElement;
    [...root.classList].filter((c) => c.startsWith('t-')).forEach((c) => root.classList.remove(c));
    root.classList.toggle('themed', t !== 'auto');
    if (t !== 'auto') root.classList.add('t-' + t);
    $('theme-name').textContent = t === 'auto' ? 'Auto' : THEMES[t];
    document.querySelectorAll('.theme-opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
    if (remember) { try { localStorage.setItem('ff-theme', t); } catch (e) { /* private window: applies now only */ } }
  };
  try { applyTheme(localStorage.getItem('ff-theme') || 'auto', false); } catch (e) { applyTheme('auto', false); }

  const popups = [['menu-btn', 'menu'], ['theme-btn', 'themes']];
  const closePopups = () => popups.forEach(([b, p]) => { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); });
  popups.forEach(([b, p]) => $(b).addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $(p).hidden;
    closePopups();
    $(p).hidden = !open;
    $(b).setAttribute('aria-expanded', String(open));
  }));
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu, .themes')) closePopups(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopups(); });
  $('menu').addEventListener('click', (e) => { if (e.target.closest('a, button')) closePopups(); });
  document.querySelectorAll('.theme-opt').forEach((b) => b.addEventListener('click', () => { applyTheme(b.dataset.theme, true); closePopups(); }));
  $('signout').addEventListener('click', async () => { await sb.auth.signOut(); me = null; location.hash = '#trucks'; route(); });

  const setChrome = () => {
    const signedIn = me && me.status === 'member';
    if (viewAs && !(realAdmin() && TYPES[viewAs] && viewAs !== 'customer')) viewAs = null;
    $('menu-btn').hidden = !signedIn;
    // the logo always goes home: the fleet for staff, their truck for customers
    const home = signedIn && isCustomer() ? '#mytrucks' : '#trucks';
    $('logo').href = home;
    $('logo').onclick = (e) => { if (location.hash === home) { e.preventDefault(); route(); } };
    $('who').textContent = !signedIn ? '' : viewAs ? `${me.name || me.email} · viewing as ${TYPES[viewAs]}`
      : (me.name || me.email) + (me.user_type ? ' · ' + typeLabel(me.user_type) : '') + (isAdmin() ? ' · admin' : '');
    document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !isAdmin(); });
    document.querySelectorAll('.staff-only').forEach((el) => { el.hidden = !signedIn || isCustomer(); });
    document.querySelectorAll('.not-sales').forEach((el) => { if (isSalesView()) el.hidden = true; });
    document.querySelectorAll('.service-only').forEach((el) => { el.hidden = !signedIn || !canSeeTickets(); });
    // Service users and admins find warnings and shocks under Service; Engineering keeps them under Fleet
    document.querySelectorAll('.not-service').forEach((el) => { if (canSeeTickets()) el.hidden = true; });
    document.querySelectorAll('.customer-only').forEach((el) => { el.hidden = !signedIn || !isCustomer(); });
    $('view-as').hidden = !(signedIn && realAdmin());
    $('view-as').value = viewAs || '';
    $('viewas-bar').hidden = !viewAs;
    $('viewas-name').textContent = viewAs ? TYPES[viewAs] : '';
  };
  const setViewAs = (v) => {
    viewAs = v && TYPES[v] && v !== 'customer' ? v : null;
    try { if (viewAs) sessionStorage.setItem('ff-view-as', viewAs); else sessionStorage.removeItem('ff-view-as'); } catch (e) { /* this tab only */ }
    route();
  };
  $('view-as').addEventListener('change', (e) => setViewAs(e.target.value));
  $('viewas-exit').addEventListener('click', () => setViewAs(null));
  const markMenu = (page) => {
    document.querySelectorAll('#menu a[data-page]').forEach((a) => {
      if (a.dataset.page === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  };

  // ---------- routing: #trucks, #truck-19227, #offline, #shocks, #edit, #edit-19227, #new, #users, #account
  const parse = () => {
    const raw = decodeURIComponent(location.hash.slice(1)) || 'trucks';
    let m;
    if ((m = /^truck-([A-Za-z0-9_-]{1,32})$/.exec(raw))) return { page: 'truck', id: m[1] };
    if ((m = /^edit-([A-Za-z0-9_-]{1,32})$/.exec(raw))) return { page: 'edit', id: m[1] };
    if ((m = /^customer-([A-Za-z0-9_-]{1,32})$/.exec(raw))) return { page: 'customer', id: m[1] };
    if ((m = /^(work|schedule|done)-([A-Za-z0-9_-]{1,32})$/.exec(raw))) return { page: 'service', kind: m[1], id: m[2] };
    if ((m = /^request-([A-Za-z0-9_-]{1,32})$/.exec(raw))) return { page: 'request', id: m[1] };
    if ((m = /^ticket-(\d{1,9})$/.exec(raw))) return { page: 'ticket', id: m[1] };
    if ((m = /^trackersettings-([A-Za-z0-9_-]{1,32})$/.exec(raw))) return { page: 'trackersettings', id: m[1] };
    if ((m = /^warnticket-([A-Za-z0-9_-]{1,32})\/(.{1,120})$/.exec(raw))) return { page: 'warnticket', id: m[1], warn: m[2] };
    if (['trucks', 'offline', 'shocks', 'warnings', 'edit', 'new', 'users', 'account', 'mytrucks', 'requests', 'newticket', 'trackers', 'trackersettings'].includes(raw)) return { page: raw, id: null };
    return { page: 'trucks', id: null };
  };
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  const route = async () => {
    const token = ++renderToken;
    closePopups();
    hideNotice();
    unsaved.dirty = () => false;
    if (!me || me.status !== 'member') {
      const { data } = await sb.auth.getSession();
      if (token !== renderToken) return;
      if (!data.session) { me = null; setChrome(); return renderSignIn(); }
      try { me = await rpc('web_me'); } catch (err) { me = null; setChrome(); showNotice('Can’t check your account.', friendly(err)); return renderSignIn(); }
      if (token !== renderToken) return;
      setChrome();
      if (me.status === 'needs_code') return renderClaim();
      if (me.status !== 'member') return renderNotInvited();
    }
    setChrome();
    currentHash = location.hash;
    let r = parse();
    // Customers only get their own trucks' customer pages and their account.
    if (isCustomer() && !['customer', 'account', 'mytrucks', 'request', 'ticket'].includes(r.page)) r = { page: 'mytrucks', id: null };
    // Service requests: Service users and admins
    if ((r.page === 'requests' && !canSeeTickets()) || ((r.page === 'newticket' || r.page === 'warnticket') && !isServiceView())) r = { page: 'trucks', id: null };
    // Sales doesn't get the offline, shocks or warnings pages
    if (isSalesView() && r.page === 'offline') r = { page: 'trucks', id: null };
    markMenu(r.page === 'truck' || r.page === 'service' ? 'trucks' : r.page === 'request' || (r.page === 'ticket' && isCustomer()) ? (isCustomer() ? 'mytrucks' : 'trucks') : r.page === 'ticket' || r.page === 'newticket' ? 'requests' : r.page === 'warnticket' ? 'warnings' : r.page === 'trackersettings' ? 'trackers' : r.page);
    window.scrollTo(0, 0);
    const adminPages = ['edit', 'new', 'users', 'trackers', 'trackersettings'];
    if (adminPages.includes(r.page) && !isAdmin()) {
      app.replaceChildren(h('div', { class: 'empty', text: 'Only Farber Fleet admins can open this page.' }));
      return;
    }
    const pages = { trucks: renderFleet, truck: renderTruck, offline: renderOffline, shocks: renderShocks, warnings: renderWarnings,
      edit: r.id ? renderEditor : renderEditList, new: renderEditor, users: renderUsers, account: renderAccount,
      customer: renderCustomer, mytrucks: renderMyTrucks, service: renderServicePage, requests: renderRequests, request: renderRequestForm,
      ticket: renderTicket, newticket: (rr, tk) => renderNewTicket(rr, tk, { heading: 'New ticket', status: 'New' }),
      warnticket: (rr, tk) => renderNewTicket(rr, tk, warningPreset(rr.warn)),
      trackers: renderTrackers, trackersettings: renderTrackerSettings };
    app.replaceChildren(h('p', { class: 'loading', text: 'Loading…' }));
    try {
      await pages[r.page](r, token);
    } catch (err) {
      if (token !== renderToken) return;
      if (/expired|JWT/i.test(err.message || '')) { await sb.auth.signOut(); me = null; return route(); }
      app.replaceChildren(h('div', { class: 'empty', text: 'This page couldn’t load. ' + friendly(err) },
        h('div', null, h('button', { class: 'btn ghost', type: 'button', style: 'margin-top:12px', onclick: () => route() }, 'Try again'))));
    }
  };
  // Leaving a form with unsaved changes takes a second try (no pop-up dialogs).
  let currentHash = location.hash;
  let ignoreHash = false;
  let leaveOk = false;
  window.addEventListener('hashchange', () => {
    if (ignoreHash) { ignoreHash = false; return; }
    if (unsaved.dirty() && !leaveOk) {
      leaveOk = true;
      ignoreHash = true;
      location.replace(currentHash || '#trucks');
      showNotice('You have changes that aren’t saved.', 'Save them, or go to the other page again to leave without saving.', 'bad');
      return;
    }
    leaveOk = false;
    currentHash = location.hash;
    route();
  });
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { me = null; setChrome(); } });

  // ---------- sign in / first sign-in
  const field = (label, attrs) => {
    const id = 'f-' + Math.random().toString(36).slice(2, 8);
    const input = h('input', { id, ...attrs });
    return { wrap: h('div', { class: 'field' }, h('label', { for: id, text: label }), input), input };
  };

  // password box with a Show / Hide button
  const pwField = (label, autocomplete) => {
    const f = field(label, { type: 'password', autocomplete, required: true, minlength: '8' });
    const btn = h('button', { type: 'button', class: 'pw-toggle', 'aria-pressed': 'false', 'aria-label': 'Show password', text: 'Show' });
    btn.addEventListener('click', () => {
      const show = f.input.type === 'password';
      f.input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      f.input.focus();
    });
    const box = h('div', { class: 'pw-wrap' });
    f.input.replaceWith(box);
    box.append(f.input, btn);
    return f;
  };
  // live "passwords match" line under the confirm box
  const matchHint = (a, b) => {
    const hint = h('p', { class: 'pw-hint', 'aria-live': 'polite' });
    const check = () => {
      if (!b.input.value) { hint.textContent = ''; hint.className = 'pw-hint'; return; }
      const ok = a.input.value === b.input.value;
      hint.className = 'pw-hint ' + (ok ? 'ok' : 'bad');
      hint.textContent = ok ? '✓ Passwords match' : '✗ Passwords don’t match yet';
    };
    a.input.addEventListener('input', check); b.input.addEventListener('input', check);
    b.wrap.append(hint);
    return check;
  };

  const renderSignIn = () => {
    let mode = 'signin';
    const status = h('p', { class: 'status', 'aria-live': 'polite' });
    const email = field('Email', { type: 'email', autocomplete: 'email', required: true });
    const pass = pwField('Password', 'current-password');
    const pass2 = pwField('Type the password again', 'new-password');
    const recheck = matchHint(pass, pass2);
    const code = field('Invite code (from your admin)', { autocomplete: 'off', placeholder: 'e.g. 7KQ2-MX9D-4HTP', spellcheck: 'false' });
    const help = h('p', { class: 'note' });
    const submit = h('button', { class: 'btn', type: 'submit' });
    const tabIn = h('button', { type: 'button', role: 'tab' }, 'Sign in');
    const tabNew = h('button', { type: 'button', role: 'tab' }, 'First time here');
    const setMode = (m) => {
      mode = m;
      tabIn.setAttribute('aria-selected', String(m === 'signin'));
      tabNew.setAttribute('aria-selected', String(m === 'new'));
      code.wrap.hidden = m !== 'new';
      pass2.wrap.hidden = m !== 'new';
      if (m !== 'new') pass2.input.value = '';
      recheck();
      pass.input.autocomplete = m === 'new' ? 'new-password' : 'current-password';
      pass.wrap.querySelector('label').textContent = m === 'new' ? 'Choose a password (8 or more characters)' : 'Password';
      submit.textContent = m === 'new' ? 'Create my sign-in' : 'Sign in';
      help.textContent = m === 'new'
        ? 'Use the email your admin added and the invite code they gave you.'
        : 'Forgot your password? Ask a Farber Fleet admin to reset your sign-in; they’ll give you a new invite code.';
      status.textContent = '';
    };
    tabIn.addEventListener('click', () => setMode('signin'));
    tabNew.addEventListener('click', () => setMode('new'));
    const form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'tabs', role: 'tablist' }, tabIn, tabNew), email.wrap, pass.wrap, pass2.wrap, code.wrap, submit, status, help);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const em = clean(email.input.value).toLowerCase();
      const pw = pass.input.value;
      if (!EMAIL_OK.test(em)) { status.className = 'status bad'; status.textContent = 'Enter your email address.'; return; }
      if (pw.length < 8) { status.className = 'status bad'; status.textContent = 'Passwords are at least 8 characters.'; return; }
      if (mode === 'new' && pw !== pass2.input.value) { status.className = 'status bad'; status.textContent = 'The two passwords don’t match.'; pass2.input.focus(); return; }
      if (mode === 'new' && clean(code.input.value).replace(/[^A-Za-z0-9]/g, '').length < 12) {
        status.className = 'status bad'; status.textContent = 'Enter the 12-character invite code.'; return;
      }
      submit.disabled = true;
      status.className = 'status busy';
      status.textContent = mode === 'new' ? 'Setting up…' : 'Signing in…';
      try {
        if (mode === 'new') {
          let { data, error } = await sb.auth.signUp({ email: em, password: pw });
          if (error && /already registered|already exists/i.test(error.message)) {
            ({ data, error } = await sb.auth.signInWithPassword({ email: em, password: pw }));
          }
          if (error) throw error;
          if (!data.session) throw new Error('Sign-up needs email confirmation turned off in Supabase (see the setup guide). Ask your admin.');
          const res = await rpc('web_claim', { p_code: code.input.value });
          if (res.status === 'bad_code') {
            await sb.auth.signOut();
            throw new Error(res.tries_left > 0 ? `That code isn’t right. ${res.tries_left} tries left before it stops working.` : 'That code stopped working. Ask your admin for a new one.');
          }
          me = res;
        } else {
          const { error } = await sb.auth.signInWithPassword({ email: em, password: pw });
          if (error) throw new Error(/Invalid login/i.test(error.message) ? 'Email or password isn’t right.' : error.message);
          me = null;
        }
        location.hash = location.hash && !/^#(account)?$/.test(location.hash) ? location.hash : '#trucks';
        route();
      } catch (err) {
        if (mode === 'new') { try { await sb.auth.signOut(); } catch (e) { /* already signed out */ } me = null; }
        status.className = 'status bad';
        status.textContent = friendly(err);
        submit.disabled = false;
      }
    });
    setMode('signin');
    app.replaceChildren(h('div', { class: 'auth' },
      h('h1', { text: 'Sign in to Farber Fleet' }), form,
      h('p', { class: 'foot', text: 'Only people added by a Farber Fleet admin can sign in.' })));
  };

  const renderClaim = () => {
    const status = h('p', { class: 'status', 'aria-live': 'polite' });
    const code = field('Invite code', { autocomplete: 'off', placeholder: 'e.g. 7KQ2-MX9D-4HTP', spellcheck: 'false' });
    const submit = h('button', { class: 'btn', type: 'submit', text: 'Continue' });
    const form = h('form', { class: 'card' },
      h('p', { text: `You’re signed in as ${me.email}. Enter the invite code your admin gave you to finish setting up.` }),
      code.wrap, submit, status,
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await sb.auth.signOut(); me = null; route(); } }, 'Sign out'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.className = 'status busy';
      status.textContent = 'Checking…';
      try {
        const res = await rpc('web_claim', { p_code: code.input.value });
        if (res.status === 'bad_code') throw new Error(res.tries_left > 0 ? `That code isn’t right. ${res.tries_left} tries left.` : 'That code stopped working. Ask your admin for a new one.');
        me = res;
        setChrome();
        go('#trucks');
      } catch (err) {
        status.className = 'status bad';
        status.textContent = friendly(err);
        submit.disabled = false;
      }
    });
    app.replaceChildren(h('div', { class: 'auth' }, h('h1', { text: 'One more step' }), form));
  };

  const renderNotInvited = () => {
    app.replaceChildren(h('div', { class: 'auth' },
      h('h1', { text: 'No access yet' }),
      h('div', { class: 'card' },
        h('p', { text: `${me.email} hasn’t been added to Farber Fleet. Ask a Farber Fleet admin to add this email, then sign in again.` }),
        h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await sb.auth.signOut(); me = null; route(); } }, 'Sign out'))));
  };

  const renderAccount = async () => {
    const status = h('p', { class: 'status', 'aria-live': 'polite' });
    const p1 = pwField('New password (8 or more characters)', 'new-password');
    const p2 = pwField('New password again', 'new-password');
    const recheck = matchHint(p1, p2);
    const submit = h('button', { class: 'btn', type: 'submit', text: 'Change password' });
    const form = h('form', { class: 'card form' }, h('h2', { text: 'Change password' }), p1.wrap, p2.wrap, h('div', { class: 'actions' }, submit, status));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (p1.input.value.length < 8) { status.className = 'status bad'; status.textContent = 'Use 8 or more characters.'; return; }
      if (p1.input.value !== p2.input.value) { status.className = 'status bad'; status.textContent = 'The two passwords don’t match.'; return; }
      submit.disabled = true;
      status.className = 'status busy'; status.textContent = 'Saving…';
      const { error } = await sb.auth.updateUser({ password: p1.input.value });
      submit.disabled = false;
      if (error) { status.className = 'status bad'; status.textContent = error.message; return; }
      p1.input.value = ''; p2.input.value = ''; recheck();
      status.className = 'status ok'; status.textContent = 'Password changed.';
    });
    app.replaceChildren(
      h('h1', { class: 'title', text: 'My account' }),
      h('div', { class: 'card' },
        h('div', { class: 'kv' }, h('span', { text: 'Email' }), h('b', { text: me.email })),
        h('div', { class: 'kv' }, h('span', { text: 'Name' }), h('b', { text: me.name || 'Not set' })),
        h('div', { class: 'kv' }, h('span', { text: 'Access' }), h('b', { text: me.role === 'admin' ? 'Admin (view, edit, add trucks, manage users)' : 'Viewer' }))),
      nameForm(),
      form);
  };
  // your name is shown on ticket changes and notes
  const nameForm = () => {
    const nm = field('Your name', { autocomplete: 'name', maxlength: '80' });
    nm.input.value = me.name || '';
    const st = h('span', { class: 'status', 'aria-live': 'polite' });
    const btn = h('button', { class: 'btn', type: 'submit', text: 'Save name' });
    const f = h('form', { class: 'card form', novalidate: true }, h('h2', { text: 'Your name' }),
      h('p', { class: 'note', text: 'Shown next to your ticket changes and notes.' }), nm.wrap, h('div', { class: 'actions' }, btn, st));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = nm.input.value.trim();
      if (!v) { st.className = 'status bad'; st.textContent = 'Type your name.'; return; }
      btn.disabled = true; st.className = 'status busy'; st.textContent = 'Saving…';
      try { const res = await rpc('web_set_my_name', { p_name: v }); me.name = res.name; setChrome(); st.className = 'status ok'; st.textContent = 'Saved.'; }
      catch (err) { st.className = 'status bad'; st.textContent = friendly(err); }
      btn.disabled = false;
    });
    return f;
  };

  // ---------- fleet list
  const renderFleet = async (r, token) => {
    const [kpis, fleet0, openReq] = await Promise.all([rpc('web_kpis'), rpc('web_fleet'), canSeeTickets() ? rpc('web_open_requests') : Promise.resolve(null)]);
    const fleet = fleet0.map(salesWarnings);
    if (token !== renderToken) return;
    const k = kpis[0] || {};
    const warnings = fleet.filter((t) => t.health === 'Warning').length;
    const sales = isSalesView();
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search number, name or city', 'aria-label': 'Search trucks' });
    const list = h('div', { class: 'list' });
    const count = h('span', { class: 'note' });
    const draw = () => {
      const q = clean(search.value).toLowerCase();
      const rows = fleet.filter((t) => !q || [t.truck_id, t.truck_name, t.near_city, t.near_state].some((v) => String(v || '').toLowerCase().includes(q)));
      count.textContent = q ? `${rows.length} of ${fleet.length} trucks` : `${fleet.length} trucks`;
      list.replaceChildren(...(rows.length ? rows.map((t) => h('a', { class: 'row', href: '#truck-' + encodeURIComponent(t.truck_id) },
        h('span', { class: 'plate', text: t.truck_id }),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-name' + (t.truck_name ? '' : ' unnamed'), text: t.truck_name || 'No name set' }),
          h('span', { class: 'row-sub', text: 'Last reported ' + ago(t.minutes_since_seen) + (t.near_city ? ' · near ' + [t.near_city, t.near_state].filter(Boolean).join(', ') : '') }),
          t.warnings ? h('span', { class: 'why', text: t.warnings }) : null),
        h('span', { class: 'row-side' }, statusPill(t.status), healthPill(t.health))))
        : [h('div', { class: 'empty', text: 'No trucks match that search.' })]));
    };
    search.addEventListener('input', draw);
    draw();
    app.replaceChildren(
      h('h1', { class: 'title', text: 'Fleet' }),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('h3', { text: 'Trucks' }), h('span', { class: 'big', text: num(k.trucks_total) }), h('span', { class: 'sub', text: `${num(k.trucks_online)} online now` })),
        sales ? null : h('a', { class: 'tile', href: '#offline' }, h('h3', { text: 'Trucks offline' }), h('span', { class: 'big' + (k.trucks_offline ? ' bad' : ''), text: num(k.trucks_offline) }), h('span', { class: 'sub', text: 'No report for 10 minutes · open list →' })),
        h('a', { class: 'tile', href: '#shocks' }, h('h3', { text: 'Shocks this week' }), h('span', { class: 'big', text: num(k.shocks_7d) }), h('span', { class: 'sub', text: `${num(k.shocks_24h)} in the last 24 hours · open list →` })),
        openReq ? h('a', { class: 'tile', href: '#requests' }, h('h3', { text: 'Open service tickets' }), h('span', { class: 'big' + (openReq.urgent ? ' bad' : openReq.new ? ' warn' : ''), text: num(openReq.open) }),
          h('span', { class: 'sub', text: `${num(openReq.new)} new · ${num(openReq.urgent)} urgent · open list →` })) : null,
        h('a', { class: 'tile', href: '#warnings' }, h('h3', { text: 'Trucks with warnings' }), h('span', { class: 'big' + (warnings ? ' warn' : ''), text: num(warnings) }), h('span', { class: 'sub', text: 'Faults, connection, overdue maintenance · open list →' }))),
      h('div', { class: 'toolbar' }, search, count),
      list);
  };

  // ---------- one truck
  const kv = (label, value, unit, cls) => h('div', { class: 'kv' }, h('span', { text: label, title: label }),
    h('b', { class: cls || null }, present(value) ? String(value) : '—', present(value) && unit ? h('span', { class: 'unit', text: unit }) : null));
  const panel = (title, ...rows) => h('div', { class: 'card panel' }, h('h3', { text: title }), ...rows);
  const tone = (field, v) => {
    if (!present(v)) return null;
    if (LOW[field]) return v < LOW[field] ? 'bad' : null;
    return null;
  };

  const lineChart = (rows, series, unit, digits, width) => {
    const W = Math.max(240, Math.round(width || 360)), H = 170, L = 46, R = 10, T = 10, B = 26;
    const pts = series.map((s) => rows.map((r) => [new Date(r.at).getTime(), r[s.key]]).filter((p) => present(p[1])));
    const all = pts.flat();
    if (!all.length) return null;
    const xs = rows.map((r) => new Date(r.at).getTime());
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    const X = (t) => L + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', series.map((s) => s.label).join(', ') + ' over time');
    const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
    for (let i = 0; i <= 3; i++) {
      const v = y0 + (y1 - y0) * (i / 3);
      add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--line)', 'stroke-width': 1 });
      add('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, num(v, digits));
    }
    const tfmt = (t) => new Date(t).toLocaleString('en-US', x1 - x0 > 86400000 * 1.5 ? { month: 'short', day: 'numeric' } : { hour: 'numeric', minute: '2-digit' });
    add('text', { x: L, y: H - 6, 'font-size': 11, fill: 'var(--muted)' }, tfmt(x0));
    add('text', { x: W - R, y: H - 6, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, tfmt(x1));
    const colors = ['var(--accent)', 'var(--s1)', 'var(--muted)'];
    pts.forEach((p, i) => {
      if (!p.length) return;
      let d = '';
      let prev = null;
      const gap = (x1 - x0) / Math.max(rows.length, 1) * 3;
      p.forEach(([t, v]) => { d += (prev === null || t - prev > gap ? 'M' : 'L') + X(t).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; prev = t; });
      add('path', { d, fill: 'none', stroke: colors[i], 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' });
    });
    const legend = h('div', { class: 'legend' }, series.map((s, i) => {
      const last = pts[i].length ? pts[i][pts[i].length - 1][1] : null;
      return h('span', null, h('i', { style: `background:${colors[i]}` }), s.label + ' ', h('b', { text: present(last) ? num(last, digits) + unit : '—' }));
    }));
    return [legend, svg];
  };


  // ---------- truck systems: what a truck has decides what's shown (and what its tracker reads)
  const SHORE_AMPS = [0, 15, 20, 30, 50, 100];
  const SLIDE_TEXT = { I: 'In', O: 'Out', M: 'Moving', E: 'Error', '-': null };
  const AWNING_TEXT = { I: 'Retracted', O: 'Extended', M: 'Moving', E: 'Error', '-': null };
  const sysOf = (t) => t.systems || null;
  const sysTanks = (sy) => ['fresh', 'gray', 'black'].filter((k) => sy.plumbing && sy.plumbing[k]);
  const sysWater = (sy) => sysTanks(sy).length > 0 || !!(sy.plumbing && sy.plumbing.jug);
  const listText = (a) => (a && a.length ? a.join(', ') : 'None');
  const BATTERY_TYPES = ['Lithium', 'AGM', 'Flooded lead-acid', 'Other'];
  const batteryText = (b) => (b && b.type ? b.type + (b.ah ? ` · ${num(b.ah)} Ah` : '') : 'None');
  // What a ticket can be about: the truck's own systems, then general areas
  const GENERAL_SYSTEMS = ['Electrical', 'Cabinetry', 'Mechanical', 'Networking', 'Audio/Video', 'Electric step', 'Other'];
  const truckSystemList = (sy) => {
    if (!sy) return [];
    return [sy.engine ? 'Truck engine' : null, sysWater(sy) ? 'Plumbing' : null, sy.jacks ? 'Jacks' : null, sy.solar ? 'Solar' : null,
      sy.shore_amps ? 'Shore power' : null, sy.battery && sy.battery.type ? 'Off-grid batteries' : null,
      ...(sy.slideouts || []).map((n) => 'Slideout: ' + n), ...(sy.generators || []).map((n) => 'Generator: ' + n),
      ...(sy.awnings || []).map((n) => 'Awning: ' + n)].filter(Boolean);
  };
  // fills a <select> with the choices; keeps a saved value even if the truck no longer lists it
  const fillSystemSelect = (sel, sy, current, emptyText) => {
    const mine = truckSystemList(sy);
    const known = new Set([...mine, ...GENERAL_SYSTEMS]);
    sel.replaceChildren(h('option', { value: '', text: emptyText || '— Not set —' }),
      mine.length ? h('optgroup', { label: 'This truck' }, mine.map((x) => h('option', { value: x, text: x }))) : null,
      h('optgroup', { label: 'General' }, GENERAL_SYSTEMS.map((x) => h('option', { value: x, text: x }))),
      current && !known.has(current) ? h('option', { value: current, text: current }) : null);
    sel.value = current || '';
  };
  // the system a warning (or an oil change) is about
  const systemForWarning = (w, sy) => {
    const g = (sy && sy.generators) || [];
    if (!w) return '';
    if (w === 'Generator' || w === 'Generator oil change overdue') return g[0] ? 'Generator: ' + g[0] : '';
    if (w === 'Generator 2') return g[1] ? 'Generator: ' + g[1] : '';
    if (['Check engine', 'Fault codes', 'Engine oil change overdue'].includes(w)) return 'Truck engine';
    if (w === 'Jacks') return 'Jacks';
    if (w === 'Tracker on backup battery') return 'Electrical';
    if (['Not reporting', 'No internet', 'On cellular with power on', 'Tracker asleep (low battery)', 'Unusual upload volume', 'Tracker code refused'].includes(w)) return 'Networking';
    return '';
  };
  const systemsPanel = (sy) => sy ? panel('Systems',
    kv('Truck engine', sy.engine ? 'Yes' : 'No (trailer)'),
    kv('Water', [...sysTanks(sy).map((k) => k[0].toUpperCase() + k.slice(1) + ' tank'), sy.plumbing && sy.plumbing.jug ? 'Jug system' : null].filter(Boolean).join(', ') || 'None'),
    kv('Leveling jacks', sy.jacks ? 'Yes' : 'No'), kv('Solar', sy.solar ? 'Yes' : 'No'),
    kv('Shore power', sy.shore_amps ? sy.shore_amps + ' A' : 'None'), kv('Off-grid batteries', batteryText(sy.battery)),
    kv('Slideouts', listText(sy.slideouts)), kv('Generators', listText(sy.generators)), kv('Awnings', listText(sy.awnings))) : null;

  // shared by the staff truck page and the customer page (cust = hide IP and firmware)
  const nowPanelsFor = (t, maint, cust) => {
    const sy = sysOf(t);
    // with systems set: what the truck has; without (older trucks): whatever the data shows
    const needs = (k) => {
      if (!sy) return t['has_' + k];
      if (k === 'generator') return (sy.generators || []).length > 0;
      if (k === 'shore') return sy.shore_amps > 0;
      if (k === 'solar') return !!sy.solar;
      if (k === 'jacks') return !!sy.jacks;
      if (k === 'plumbing') return sysWater(sy);
      if (k === 'aux') return !!(sy.battery && sy.battery.type);
      return t['has_' + k];
    };
    const engine = sy ? !!sy.engine : true;
    const genNames = sy ? (sy.generators || []) : (t.has_generator ? ['Generator'] : []);
    const unitRows = (names, states, text) => (names || []).map((n, i) => {
      const c = (states || '')[i] || '-';
      return kv(n, text[c] ?? null, null, c === 'E' ? 'bad' : c === 'M' ? 'warn' : null);
    });
    // oil changes (and any other due-date items) shown inside the Truck and Generator cards
    const hrsFmt = (v, d) => num(v, d === undefined ? (Number.isInteger(Number(v)) ? 0 : 1) : d) + ' h';
    const dueRows = (m) => {
      const byHours = present(m.interval_hours);
      let st, cls;
      if (m.status === 'Overdue') { cls = 'bad'; st = byHours && present(m.hours_left) && m.hours_left <= 0 ? `Overdue by ${hrsFmt(-m.hours_left)}` : `Overdue by ${m.days_overdue} day${m.days_overdue === 1 ? '' : 's'}`; }
      else if (m.status === 'OK') { cls = 'ok'; st = byHours && present(m.hours_left) ? `OK, ${hrsFmt(m.hours_left)} left` : present(m.days_overdue) ? `OK, due in ${-m.days_overdue} days` : 'OK'; }
      else { cls = 'warn'; st = m.status === 'No hour reading' ? 'No hour meter reading' : 'No record'; }
      const label = m.name.replace(/^Generator /, '').replace(/^Engine /, '');
      const cap = label.charAt(0).toUpperCase() + label.slice(1);
      return [
        kv(cap, st, null, cls),
        kv('Last ' + label, m.last_done ? fmtDay(m.last_done) + (byHours && present(m.last_hours) ? ` at ${hrsFmt(m.last_hours)}` : '') : 'Never'),
        kv('Next due', [byHours && present(m.next_due_hours) ? `at ${hrsFmt(m.next_due_hours)}` : '', m.next_due ? fmtDay(m.next_due) : ''].filter(Boolean).join(' or ') || null),
      ];
    };
    const genMaint = (maint || []).filter((m) => /^generator/.test(m.code));
    const truckMaint = (maint || []).filter((m) => !/^generator/.test(m.code) || !needs('generator'));
    const tanks = sy ? sysTanks(sy) : ['fresh', 'gray', 'black'];
    const nowPanels = [
      needs('temps') && panel('Temperatures',
        [1, 2, 3, 4, 5, 6].map((i) => kv(t['temp' + i + '_label'] || 'Temp ' + i, num(t['temp' + i + '_f'], 1), '°F'))),
      engine && panel('Truck',
        kv('Engine', t.engine), kv('Speed', num(t.speed_mph), ' mph'), kv('RPM', num(t.rpm)), kv('Mileage', num(t.odometer_mi), ' mi'), kv('Fuel', num(t.fuel_pct), '%'),
        needs('oil') && kv('Oil pressure', num(t.oil_psi), ' psi'), kv('Coolant', num(t.coolant_f), '°F'),
        kv('Fault codes', present(t.dtc_count) ? t.dtc_count : null, null, t.dtc_count > 0 ? 'bad' : null),
        truckMaint.flatMap(dueRows)),
      panel('Batteries',
        kv('Chassis', num(t.chassis_v, 1), ' V', tone('chassis_v', t.chassis_v)),
        needs('aux') && kv(sy ? 'Off-grid' : 'Aux', num(t.aux_v, 1), ' V', tone('aux_v', t.aux_v)),
        needs('aux') && kv(sy ? 'Off-grid current' : 'Aux current', num(t.aux_a, 1), ' A'),
        needs('aux') && sy && sy.battery && sy.battery.ah ? kv('Off-grid bank', batteryText(sy.battery)) : null,
        kv('Tracker battery', num(t.board_v, 2), ' V', tone('board_v', t.board_v)),
        cust ? null : kv('Tracker power', t.tracker_power, null, t.tracker_power === 'Backup battery' ? 'warn' : null)),
      needs('generator') && panel(genNames[0] || 'Generator',
        kv('Generator', t.generator, null, t.generator === 'Error' ? 'bad' : null), kv('Error code', t.gen_error_code),
        kv('Hour meter', num(t.gen_hours, 1), ' h'), kv('Generator battery', num(t.gen_battery_v, 1), ' V'),
        genMaint.flatMap(dueRows)),
      genNames.length > 1 && panel(genNames[1],
        kv('Generator', t.generator2, null, t.generator2 === 'Error' ? 'bad' : null), kv('Error code', t.gen2_error_code),
        kv('Hour meter', num(t.gen2_hours, 1), ' h'), kv('Generator battery', num(t.gen2_battery_v, 1), ' V')),
      needs('shore') && panel('Shore power', sy && sy.shore_amps ? kv('Service', sy.shore_amps + ' A') : null,
        kv('Shore power', t.shore), kv('Draw', num(t.shore_amps, 1), ' A', sy && sy.shore_amps && t.shore_amps > sy.shore_amps * 0.8 ? 'warn' : null)),
      needs('solar') && panel('Solar', kv('Output', num(t.solar_w), ' W')),
      needs('plumbing') && panel('Water',
        tanks.includes('fresh') && kv('Fresh', num(t.fresh_pct), '%'),
        sy && sy.plumbing && sy.plumbing.jug && kv('Fresh water', 'Jug system'),
        tanks.includes('gray') && kv('Gray', num(t.gray_pct), '%'), tanks.includes('black') && kv('Black', num(t.black_pct), '%'), kv('Pump', t.pump)),
      needs('jacks') && panel('Jacks', kv('Jacks', t.jacks, null, t.jacks === 'Error' ? 'bad' : null), kv('Error code', t.jacks_error_code)),
      sy && (sy.slideouts || []).length > 0 && panel('Slideouts', unitRows(sy.slideouts, t.slide_states, SLIDE_TEXT)),
      sy && (sy.awnings || []).length > 0 && panel('Awnings', unitRows(sy.awnings, t.awning_states, AWNING_TEXT)),
      panel(cust ? 'Location' : 'Location and network',
        h('div', { class: 'kv' }, h('span', { text: 'Near' }), present(t.lat)
          ? h('a', { href: mapUrl(t.lat, t.lon), target: '_blank', rel: 'noopener', text: [t.near_city, t.near_state].filter(Boolean).join(', ') || 'Map' })
          : h('b', { text: '—' })),
        cust ? kv('Farber Fleet Connection', t.status, null, t.status === 'Online' ? 'ok' : t.status === 'Asleep' ? 'warn' : 'bad') : kv('Connection', t.network),
        !cust && t.network === 'Wi-Fi' ? kv('Wi-Fi network', t.wifi_ssid) : null,
        !cust && t.network === 'Cellular' ? kv('Last on Wi-Fi', t.last_wifi_at ? ago(Math.round((Date.now() - new Date(t.last_wifi_at).getTime()) / 60000)) : 'Never') : null,
        cust ? null : kv('IP address', t.ip_addr),
        cust ? null : kv('Firmware', t.fw),
        cust || !t.tracker ? null : kv('Tracker board', t.tracker.device_id),
        cust ? null : kv('Reports every', t.power_state === 'asleep' ? 'Once a day (asleep)' : fmtEvery(t.report_interval_s) || '10 min (not set by tracker)'),
        !cust && t.power_state === 'asleep' ? kv('Tracker asleep since', t.power_state_at ? fmtTime(t.power_state_at) : null, null, 'warn') : null),
    ].filter(Boolean);

    return { nowPanels };
  };
  // ---------- the truck's tracker: hotspot (to read to a customer) and setup codes
  const copyTo = async (text, el, statusEl) => {
    try { await navigator.clipboard.writeText(text); statusEl.textContent = 'Copied'; }
    catch (e) { const rg = document.createRange(); rg.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); statusEl.textContent = 'Selected: press Ctrl+C'; }
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  };
  const b64url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const setupBox = h('div', { class: 'notice good setup-code', hidden: true });
  const showSetupCode = (t, res) => {
    // server + truck + code in one string; the tracker's setup page takes it as is
    const code = 'FF1-' + b64url(JSON.stringify({ u: CFG.supabaseUrl, k: CFG.supabaseKey, t: res.truck_id, c: res.token }));
    const hs = res.hotspot || {};
    const msg = [
      `Farber Fleet setup code for truck ${res.truck_id}:`, '', code, '',
      'Copy the code first (the tracker’s hotspot has no internet). Then:',
      `1. On your phone, join the Wi-Fi network ${hs.ap_name || 'FarberFleet-' + res.truck_id}${hs.ap_pass ? ` (password: ${hs.ap_pass})` : ' (the password is on the tracker’s sticker)'}.`,
      '   If the network isn’t there, hold the tracker’s BOOT button for 2 seconds.',
      '2. The setup page opens by itself (or go to http://192.168.4.1).',
      '3. Paste the code under "Setup code from Farber" and press "Use this code".',
    ].join('\n');
    const codeEl = h('code', { class: 'copy-val mono', text: code });
    const pre = h('pre', { class: 'code', text: msg });
    const st1 = h('span', { class: 'status ok' }), st2 = h('span', { class: 'status ok' });
    setupBox.hidden = false;
    setupBox.replaceChildren(
      h('strong', { text: `Setup code for truck ${res.truck_id}` }),
      h('p', { class: 'note', text: 'Send it to the customer. The tracker’s current code keeps working until this one is used; then the old one stops. Making another code cancels this one.' }),
      h('div', { class: 'copy-row' }, h('span', { class: 'copy-label', text: 'Code' }), codeEl,
        h('button', { class: 'btn small ghost', type: 'button', text: 'Copy', onclick: () => copyTo(code, codeEl, st1) }), st1),
      h('details', { class: 'copy-msg', open: true }, h('summary', { text: 'Message for the customer' }), pre),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Copy message', onclick: () => copyTo(msg, pre, st2) }), st2));
    setupBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const trackerPanel = (t, hs) => {
    const passEl = h('b', { class: 'mono', text: hs && hs.ap_pass ? '••••••••' : '—' });
    let shown = false;
    const showBtn = hs && hs.ap_pass ? h('button', { type: 'button', class: 'link-btn', text: 'Show', onclick: () => {
      shown = !shown; passEl.textContent = shown ? hs.ap_pass : '••••••••'; showBtn.textContent = shown ? 'Hide' : 'Show'; } }) : null;
    const st = h('span', { class: 'status' });
    let armed = false;
    const codeBtn = isAdmin() ? h('button', { class: 'btn small ghost', type: 'button', text: 'Make a setup code', onclick: async () => {
      if (!armed) { armed = true; codeBtn.textContent = 'Make a setup code — press again'; st.className = 'status'; st.textContent = 'For a customer to type on the tracker (new truck code, or after a server move).'; return; }
      codeBtn.disabled = true;
      try { showSetupCode(t, await rpc('web_tracker_setup_code', { p_truck: t.truck_id })); st.textContent = ''; }
      catch (err) { st.className = 'status bad'; st.textContent = friendly(err); }
      codeBtn.disabled = false; armed = false; codeBtn.textContent = 'Make a setup code';
    } }) : null;
    return h('div', { class: 'card panel' }, h('h3', { text: 'Tracker' }),
      kv('Board', hs ? hs.device_id : 'No tracker yet'),
      kv('Hotspot name', hs && hs.ap_name),
      h('div', { class: 'kv' }, h('span', { text: 'Hotspot password' }), h('span', { class: 'kv-val' }, passEl, showBtn ? ' ' : null, showBtn)),
      h('p', { class: 'note', text: 'Read these to a customer who lost the sticker. Only Farber Service and admins see them.' }),
      codeBtn ? h('div', { class: 'actions' }, codeBtn, st) : null);
  };

  const renderTruck = async (r, token) => {
    const id = r.id;
    setupBox.hidden = true;
    const [trows, maint, events, reqs, hotspot] = await Promise.all([rpc('web_truck', { p_truck: id }), rpc('web_truck_maint', { p_truck: id }), rpc('web_truck_events', { p_truck: id }),
      canSeeTickets() ? rpc('web_truck_requests', { p_truck: id }) : Promise.resolve(null),
      isServiceView() ? rpc('web_truck_hotspot', { p_truck: id }).catch(() => null) : Promise.resolve(undefined)]);
    if (token !== renderToken) return;
    const t = trows[0];
    if (!t) { app.replaceChildren(h('a', { class: 'back', href: '#trucks', text: '← All trucks' }), h('div', { class: 'empty', text: `There is no truck ${id}.` })); return; }

    if (isSalesView() && t.warnings) {
      const w = String(t.warnings).split(', ').filter((x) => !NET_WARNINGS.includes(x)).join(', ');
      t.warnings = w || null; t.health = w ? 'Warning' : 'Good';
    }
    const { nowPanels } = nowPanelsFor(t, maint, isSalesView());

    const histBox = h('div', { class: 'charts' }, h('p', { class: 'loading', text: 'Loading history…' }));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time window' }, [[6, '6 hours'], [24, '24 hours'], [72, '3 days'], [168, '7 days']].map(([v, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === historyHours), onclick: (e) => {
        historyHours = v;
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        loadHistory();
      } }, label)));
    const loadHistory = async () => {
      const tk = renderToken;
      histBox.replaceChildren(h('p', { class: 'loading', text: 'Loading history…' }));
      try {
        const rows = await rpc('web_history', { p_truck: id, p_hours: historyHours });
        if (tk !== renderToken) return;
        const sy = sysOf(t);
        const gens = sy ? (sy.generators || []) : ['Generator'];
        const tanksH = sy ? sysTanks(sy) : ['fresh', 'gray', 'black'];
        const defs = [
          ['Speed', [{ key: 'speed_mph', label: 'Speed' }], ' mph', 0],
          ['Temperatures 1–3', [1, 2, 3].map((i) => ({ key: 'temp' + i + '_f', label: t['temp' + i + '_label'] || 'Temp ' + i })), '°F', 1],
          ['Temperatures 4–6', [4, 5, 6].map((i) => ({ key: 'temp' + i + '_f', label: t['temp' + i + '_label'] || 'Temp ' + i })), '°F', 1],
          ['Batteries', [{ key: 'chassis_v', label: 'Chassis' }, { key: 'aux_v', label: 'Aux' }], ' V', 2],
          (!sy || sy.engine) && ['Fuel', [{ key: 'fuel_pct', label: 'Fuel' }], '%', 0],
          tanksH.length && ['Water tanks', tanksH.map((k) => ({ key: k + '_pct', label: k[0].toUpperCase() + k.slice(1) })), '%', 0],
          (!sy || sy.solar) && ['Solar', [{ key: 'solar_w', label: 'Solar' }], ' W', 0],
          (!sy || sy.shore_amps > 0) && ['Shore power draw', [{ key: 'shore_amps', label: 'Shore' }], ' A', 1],
          gens.length && ['Generator battery', [{ key: 'gen_battery_v', label: gens[0] }, gens[1] ? { key: 'gen2_battery_v', label: gens[1] } : null].filter(Boolean), ' V', 2],
        ].filter(Boolean);
        // draw at the real size so the text stays readable: work out the column width first
        const boxW = histBox.clientWidth || 360;
        const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const cols = Math.max(1, Math.floor((boxW + 12) / (22 * remPx + 12)));
        const colW = (boxW - 12 * (cols - 1)) / cols - 34;
        const charts = defs.map(([title, series, unit, d]) => {
          const c = lineChart(rows, series, unit, d, colW);
          return c ? h('div', { class: 'card chart' }, h('h3', { text: title }), ...c) : null;
        }).filter(Boolean);
        histBox.replaceChildren(...(charts.length ? charts : [h('div', { class: 'empty', text: 'No reports in this time window.' })]));
      } catch (err) {
        histBox.replaceChildren(h('div', { class: 'empty', text: 'History couldn’t load. ' + friendly(err) }));
      }
    };

    const eventRows = events.map((e) => h('tr', { class: e.kind === 'warning' ? 'warn-row' : null },
      h('td', { class: 'first', 'data-label': 'When', text: fmtTime(e.at) }),
      h('td', { 'data-label': 'Event', class: e.kind === 'warning' ? 'warn' : null, text: e.event }),
      h('td', { 'data-label': 'Where' }, present(e.lat)
        ? h('a', { href: mapUrl(e.lat, e.lon), target: '_blank', rel: 'noopener', text: [e.near_city, e.near_state].filter(Boolean).join(', ') || 'Map' })
        : '—')));

    const team = ROLE_FIELDS.map(([k, label]) => kv(label, t[k]));
    const detailPanels = [
        panel('Build and delivery', kv('Build date', t.build_date), kv('Delivery date', t.delivery_date), kv('In service', t.in_service)),
        panel('Address', h('address', { class: 'addr' }, t.company ? h('strong', { text: t.company }) : null, [t.address_line1, t.address_line2, t.address_city, t.address_country].filter(present).map((x) => h('span', { text: x })))),
        panel('Contact', kv('Name', t.contact_name), kv('Title', t.contact_title),
          h('div', { class: 'kv' }, h('span', { text: 'Phone' }), t.contact_phone ? h('a', { href: 'tel:' + String(t.contact_phone).replace(/[^0-9+]/g, ''), text: t.contact_phone }) : h('b', { text: '—' })),
          h('div', { class: 'kv' }, h('span', { text: 'Email' }), t.contact_email ? h('a', { href: 'mailto:' + t.contact_email, text: t.contact_email }) : h('b', { text: '—' }))),
        panel('Farber team', team), systemsPanel(sysOf(t)), hotspot !== undefined ? trackerPanel(t, hotspot) : null].filter(Boolean);
    const customerBtn = h('a', { class: 'btn ghost small', href: '#customer-' + encodeURIComponent(t.truck_id), text: 'View customer page' });
    // No tracker yet (new truck) or one assigned that hasn't sent anything yet
    const trackerNote = t.status === 'No tracker'
      ? h('div', { class: 'notice', role: 'status' }, h('strong', { text: 'No tracker connected to this truck.' }), ' ',
          isAdmin() ? h('span', null, 'Power up a tracker, then assign it to ' + t.truck_id + ' on the ', h('a', { href: '#trackers', text: 'Trackers page' }), '. Readings show here once it sends.')
            : h('span', { text: 'Readings show here once a tracker is set up.' }))
      : t.status === 'Setting up'
        ? h('div', { class: 'notice', role: 'status' }, h('strong', { text: 'Tracker ' + (t.tracker ? t.tracker.device_id + ' ' : '') + 'is assigned to this truck' }),
            ' and starts sending the next time it checks in (within a minute when it’s online).')
        : null;
    // Sales: location, truck details, warnings, tickets and the customer page
    if (isSalesView()) {
      app.replaceChildren(
        h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
        h('h1', { class: 'title' }, t.truck_id, t.truck_name ? h('span', { class: 'sub', text: ' · ' + t.truck_name }) : null),
        h('div', { class: 'meta' }, statusPill(t.status), healthPill(t.health), t.warnings ? h('a', { class: 'why', href: '#warnings', text: t.warnings }) : null,
          h('span', { text: 'Last report ' + ago(t.minutes_since_seen) }), customerBtn),
        trackerNote,
        h('div', { class: 'section-head' }, h('h2', { text: 'Truck details' })),
        h('div', { class: 'panels' }, nowPanels[nowPanels.length - 1], ...detailPanels),
        reqs ? h('div', { class: 'section-head' }, h('h2', { text: 'Service tickets' }), h('a', { class: 'note', href: '#requests', text: 'All service tickets →' })) : null,
        reqs ? truckRequestsCard(reqs, false) : null);
      return;
    }
    app.replaceChildren(
      h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
      h('h1', { class: 'title' }, t.truck_id, t.truck_name ? h('span', { class: 'sub', text: ' · ' + t.truck_name }) : null),
      h('div', { class: 'meta' }, statusPill(t.status), healthPill(t.health), t.warnings ? h('span', { class: 'why', text: t.warnings }) : null,
        t.status === 'No tracker' || t.status === 'Setting up' ? null : h('span', { text: 'Last report ' + ago(t.minutes_since_seen) }),
        isAdmin() ? h('a', { href: '#edit-' + encodeURIComponent(t.truck_id), text: 'Edit truck' }) : null,
        isAdmin() ? customerBtn : null,
        isAdmin() ? h('a', { class: 'btn ghost small', href: '#trackersettings-' + encodeURIComponent(t.truck_id), text: 'Tracker settings' }) : null),
      trackerNote,
      h('div', { class: 'section-head' }, h('h2', { text: 'Truck details' })),
      setupBox,
      h('div', { class: 'panels' },
        ...detailPanels),
      isServiceView() ? h('div', { class: 'section-head' }, h('h2', { text: 'Maintenance' }), h('p', { class: 'note', text: 'Oil changes are in the Truck and Generator cards under Right now.' })) : null,
      isServiceView() ? h('div', { class: 'actions service-actions' }, Object.entries(SERVICE_PAGES).map(([k, label]) =>
        h('a', { class: 'btn', href: '#' + k + '-' + encodeURIComponent(t.truck_id), text: label }))) : null,
      reqs ? h('div', { class: 'section-head' }, h('h2', { text: 'Service tickets' }), h('a', { class: 'note', href: '#requests', text: 'All service tickets →' })) : null,
      reqs ? truckRequestsCard(reqs, false) : null,
      h('div', { class: 'section-head' }, h('h2', { text: 'Events' }), h('p', { class: 'note', text: 'Last 30 days, with when and where each warning started' })),
      h('div', { class: 'card scroll' }, eventRows.length ? h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['When', 'Event', 'Where'].map((x) => h('th', { text: x })))),
        h('tbody', null, eventRows)) : h('p', { class: 'muted', text: 'No events in the last 30 days.' })),
      h('div', { class: 'section-head' }, h('h2', { text: 'Right now' }), h('p', { class: 'note', text: 'Latest report. Equipment this truck doesn’t have is left out.' })),
      h('div', { class: 'panels' }, nowPanels),
      h('div', { class: 'section-head' }, h('h2', { text: 'History' }), seg),
      histBox);
    loadHistory();
  };

  // ---------- offline and shocks
  // a ticket for a warning: Open ticket fills the form from the warning
  const WARN_TICKET = {
    'Not reporting': ['Tracker not reporting', 'Repair'], 'Check engine': ['Check engine light', 'Repair'], 'Fault codes': ['Engine fault codes', 'Repair'],
    Generator: ['Generator fault', 'Repair'], Jacks: ['Leveling jacks fault', 'Repair'], 'No internet': ['No internet on the truck', 'Repair'],
    'On cellular with power on': ['On cellular while powered (truck Wi-Fi down)', 'Repair'],
    'Tracker asleep (low battery)': ['Tracker backup battery low (tracker asleep)', 'Repair'],
    'Generator 2': ['Second generator fault', 'Repair'], Slideout: ['Slideout fault', 'Repair'], Awning: ['Awning fault', 'Repair'],
    'Slideout out while moving': ['Slideout was out while driving', 'Inspection'], 'Awning out while moving': ['Awning was out while driving', 'Inspection'],
    'Unusual upload volume': ['Tracker sending far too much data (faulty or stolen tracker?)', 'Repair'],
    'Tracker code refused': ['Uploads with a wrong truck code (old or stolen tracker?)', 'Repair'],
    'Tracker on backup battery': ['Tracker lost truck power (running on its backup battery)', 'Repair'],
  };
  const OVERDUE_TYPE = { 'Engine oil change overdue': 'engine_oil', 'Generator oil change overdue': 'generator_oil' };
  const warningPreset = (w) => {
    const [title, category] = WARN_TICKET[w] || [w, OVERDUE_TYPE[w] || /overdue$/.test(w) ? 'Maintenance' : 'Repair'];
    return { heading: 'New ticket for a warning', status: 'New', category, title, type_code: OVERDUE_TYPE[w] || '', warning_key: w,
      details: `Opened from the warning “${w}” on ${fmtDay(todayIso())}.` };
  };

  const renderWarnings = async (r, token) => {
    const [fleet0, wt] = await Promise.all([rpc('web_fleet'), rpc('web_warning_tickets')]);
    if (token !== renderToken) return;
    const fleet = fleet0.map(salesWarnings);
    const rows = fleet.filter((t) => t.health === 'Warning')
      .map((t) => ({ ...t, list: String(t.warnings || '').split(', ').filter(Boolean)
        .map((w) => ({ w, tks: wt.filter((k) => k.truck_id === t.truck_id && (k.warning_key === w || k.overdue_key === w)) })) }))
      .sort((a, b) => b.list.length - a.list.length || String(a.truck_id).localeCompare(String(b.truck_id)));
    const all = rows.flatMap((t) => t.list);
    const needs = all.filter((x) => !x.tks.length).length;
    let onlyNeeds = false;
    const box = h('div', { class: 'warn-cards' });
    const ticketCell = (t, x) => {
      if (x.tks.length) return h('div', { class: 'wc-tickets' }, x.tks.map((k) => h('div', { class: 'wc-ticket' },
        canOpenTickets() ? ticketLink(k.ticket_no) : h('span', { class: 'ticket-no', text: '#' + k.ticket_no }),
        h('span', { class: 'pill ' + (REQ_TONE[k.status] || 'muted'), text: k.status }),
        h('span', { class: 'wc-title', text: k.title, title: k.title }))));
      return isServiceView()
        ? h('a', { class: 'btn small ghost wc-open', href: '#warnticket-' + encodeURIComponent(t.truck_id) + '/' + encodeURIComponent(x.w), text: '+ Open ticket' })
        : h('span', { class: 'note', text: 'No ticket yet' });
    };
    const draw = () => {
      const shown = rows.map((t) => ({ ...t, list: onlyNeeds ? t.list.filter((x) => !x.tks.length) : t.list })).filter((t) => t.list.length);
      box.replaceChildren(...(shown.length ? shown.map((t) => h('section', { class: 'card warn-card' },
        h('header', { class: 'wc-head' },
          h('a', { class: 'wc-truck', href: '#truck-' + encodeURIComponent(t.truck_id) }, h('span', { class: 'plate', text: t.truck_id }), h('span', { text: t.truck_name || 'No name set' })),
          h('div', { class: 'wc-meta' }, h('span', { class: 'note', text: t.last_seen ? 'Last report ' + ago(t.minutes_since_seen) : 'Never reported' }))),
        h('ul', { class: 'wc-list' }, t.list.map((x) => h('li', { class: 'wc-row' + (x.tks.length ? ' has-ticket' : '') },
          h('span', { class: 'wc-warn' }, h('span', { class: 'wc-dot', 'aria-hidden': 'true' }), x.w),
          ticketCell(t, x))))))
        : [h('div', { class: 'empty', text: onlyNeeds ? 'Every warning has a ticket.' : 'No warnings. Every truck is good.' })]));
    };
    const toggle = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
      [['all', `All warnings (${all.length})`], ['needs', `Needs a ticket (${needs})`]].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String((k === 'needs') === onlyNeeds), text: l, onclick: (e) => {
        onlyNeeds = k === 'needs'; toggle.querySelectorAll('button').forEach((b2) => b2.setAttribute('aria-pressed', String(b2 === e.currentTarget))); draw();
      } })));
    draw();
    app.replaceChildren(
      h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
      h('h1', { class: 'title', text: `Trucks with warnings (${rows.length})` }),
      h('p', { class: 'lede', text: `${all.length} ${all.length === 1 ? 'warning' : 'warnings'} on ${rows.length} ${rows.length === 1 ? 'truck' : 'trucks'}. ${needs ? `${needs} still ${needs === 1 ? 'needs' : 'need'} a ticket.` : 'Every warning has a ticket.'}` }),
      rows.length ? h('div', { class: 'toolbar' }, toggle) : null,
      box);
  };

  const renderOffline = async (r, token) => {
    const rows = await rpc('web_offline');
    if (token !== renderToken) return;
    const bat = (v, key, d) => h('span', { class: tone(key, v) || null, text: present(v) ? num(v, d) + ' V' : '—' });
    app.replaceChildren(
      h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
      h('h1', { class: 'title', text: `Trucks offline (${rows.length})` }),
      h('p', { class: 'lede', text: 'Trucks with no report for 10 minutes or more, longest first. Batteries are from the last report; red is low.' }),
      rows.length ? h('div', { class: 'card scroll' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['Truck', 'Last update', 'Chassis', 'Aux', 'Tracker', 'Last location', 'Map'].map((x) => h('th', { text: x })))),
        h('tbody', null, rows.map((t) => h('tr', null,
          h('td', { class: 'first', 'data-label': 'Truck' }, h('a', { href: '#truck-' + encodeURIComponent(t.truck_id), text: t.truck_id + (t.truck_name ? ' · ' + t.truck_name : '') })),
          h('td', { 'data-label': 'Last update', text: t.last_seen ? `${fmtTime(t.last_seen)} (${ago(t.minutes_since_seen)})` : 'Never reported' }),
          h('td', { 'data-label': 'Chassis' }, bat(t.chassis_v, 'chassis_v', 1)),
          h('td', { 'data-label': 'Aux' }, bat(t.aux_v, 'aux_v', 1)),
          h('td', { 'data-label': 'Tracker' }, bat(t.board_v, 'board_v', 2)),
          h('td', { 'data-label': 'Last location', text: [t.city, t.state].filter(Boolean).join(', ') || '—' }),
          h('td', { 'data-label': 'Map' }, present(t.lat) ? h('a', { href: mapUrl(t.lat, t.lon), target: '_blank', rel: 'noopener', text: 'Map ↗' }) : '—'))))))
        : h('div', { class: 'empty', text: 'Every truck is reporting.' }));
  };

  const renderShocks = async (r, token) => {
    const rows = await rpc('web_shocks');
    if (token !== renderToken) return;
    const sevCls = { Severe: 'bad', Moderate: 'warn', Minor: 'muted' };
    app.replaceChildren(
      h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
      h('h1', { class: 'title', text: `Shocks this week (${rows.length})` }),
      h('p', { class: 'lede', text: 'Severity is the peak jolt the G sensor measured: Minor under 3 g, Moderate 3 to 3.9 g, Severe 4 g or more. City is the nearest city or town.' }),
      rows.length ? h('div', { class: 'card scroll' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['Date and time', 'Truck', 'Speed', 'Severity', 'City', 'State', 'Map'].map((x) => h('th', { text: x })))),
        h('tbody', null, rows.map((s) => h('tr', null,
          h('td', { class: 'first', 'data-label': 'When', text: fmtTime(s.at) }),
          h('td', { 'data-label': 'Truck' }, h('a', { href: '#truck-' + encodeURIComponent(s.truck_id), text: s.truck_id + (s.truck_name ? ' · ' + s.truck_name : '') })),
          h('td', { 'data-label': 'Speed', text: present(s.speed_mph) ? s.speed_mph + ' mph' : '—' }),
          h('td', { 'data-label': 'Severity', class: sevCls[s.severity] || null, text: s.severity ? `${s.severity} (${num(s.peak_g, 1)} g)` : '—' }),
          h('td', { 'data-label': 'City', text: s.city || '—' }),
          h('td', { 'data-label': 'State', text: s.state || '—' }),
          h('td', { 'data-label': 'Map' }, present(s.lat) ? h('a', { href: mapUrl(s.lat, s.lon), target: '_blank', rel: 'noopener', text: 'Map ↗' }) : '—'))))))
        : h('div', { class: 'empty', text: 'No shocks in the last 7 days.' }));
  };

  // ---------- tracker boards and their settings (admin)
  const minsSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null);
  // press-twice button for things that are hard to undo
  const twice = (label, warn, say, fn, cls) => {
    let armed = false;
    const b = h('button', { class: 'btn small ' + (cls || 'ghost'), type: 'button', text: label });
    b.addEventListener('click', async () => {
      if (!armed) { armed = true; b.textContent = label + ' — press again'; say('bad', warn); return; }
      b.disabled = true;
      try { await fn(); } catch (err) { say('bad', friendly(err)); b.disabled = false; }
    });
    return b;
  };

  const renderTrackers = async (r, token) => {
    const [list, data] = await Promise.all([rpc('web_trackers'), loadEditData()]);
    if (token !== renderToken) return;
    const status = h('p', { class: 'status', 'aria-live': 'polite' });
    const say = (cls, text) => { status.className = 'status ' + cls; status.textContent = text; };
    const onTruck = Object.fromEntries(list.filter((k) => k.truck_id).map((k) => [k.truck_id, k.device_id]));
    const truckPick = (current) => h('select', { 'aria-label': 'Truck' }, h('option', { value: '', text: 'Pick a truck…' }),
      data.trucks.filter((t) => t.truck_id !== current).map((t) => h('option', { value: t.truck_id,
        text: t.truck_id + (t.name ? ' · ' + t.name : '') + (onTruck[t.truck_id] ? ' (has ' + onTruck[t.truck_id] + ')' : '') })));
    const assignBox = (k) => {
      const sel = truckPick(k.truck_id);
      const btn = h('button', { class: 'btn small', type: 'button', text: k.truck_id ? 'Move' : 'Assign', disabled: true });
      let armed = false;
      sel.addEventListener('change', () => { btn.disabled = !sel.value; armed = false; btn.textContent = k.truck_id ? 'Move' : 'Assign'; });
      btn.addEventListener('click', async () => {
        const other = onTruck[sel.value];
        if (other && !armed) {
          armed = true; btn.textContent += ' — press again';
          say('bad', `Truck ${sel.value} already has tracker ${other}. It will stop being accepted and go back to “Waiting for a truck”.`);
          return;
        }
        btn.disabled = true;
        try {
          await rpc('web_tracker_assign', { p_device: k.device_id, p_truck: sel.value });
          await route();
          showNotice(`${k.device_id} is now on truck ${sel.value}.`, 'The tracker picks it up the next time it checks in (within a minute when it’s online).', 'good');
        } catch (err) { say('bad', friendly(err)); btn.disabled = false; }
      });
      return h('div', { class: 'assign' }, sel, btn);
    };
    const seen = (k) => {
      const m = minsSince(k.last_seen);
      return [k.last_seen ? 'Checked in ' + ago(m) : 'Never checked in',
        present(k.last_battery_v) ? (k.last_battery_v < 2.5 ? 'outside power' : num(k.last_battery_v, 2) + ' V') : null,
        k.last_via === 'wifi' ? 'Wi-Fi' + (k.last_ssid ? ' ' + k.last_ssid : '') : k.last_via === 'lte' ? 'Cellular' : null,
        k.place, k.fw ? 'firmware ' + k.fw : null].filter(Boolean).join(' · ');
    };
    const waiting = list.filter((k) => !k.truck_id);
    const assigned = list.filter((k) => k.truck_id);
    const row = (k) => h('tr', null,
      h('td', { class: 'first', 'data-label': 'Tracker' }, h('div', { class: 'mono', text: k.device_id }), h('div', { class: 'note', text: seen(k) })),
      h('td', { 'data-label': 'Truck' }, k.truck_id
        ? h('div', null, h('a', { href: '#truck-' + encodeURIComponent(k.truck_id), text: k.truck_id + (k.truck_name ? ' · ' + k.truck_name : '') }),
          h('div', { class: 'note ' + (k.token_waiting ? 'warn' : ''), text: k.token_waiting ? 'Waiting for the tracker to pick this up'
            : k.settings_current ? 'Settings up to date' : 'New settings go out on its next send' }))
        : h('span', { class: 'warn', text: 'Waiting for a truck' })),
      h('td', { 'data-label': 'Actions' }, h('div', { class: 'actions' }, assignBox(k),
        k.truck_id ? h('a', { class: 'btn ghost small', href: '#trackersettings-' + encodeURIComponent(k.truck_id), text: 'Settings' }) : null,
        k.truck_id ? twice('Unassign', `${k.device_id} stops sending as truck ${k.truck_id} and goes back to “Waiting for a truck”.`, say,
          async () => { await rpc('web_tracker_assign', { p_device: k.device_id, p_truck: null }); route(); }) : null,
        twice('Forget', `Removes ${k.device_id} from this list${k.truck_id ? ' and stops it sending as truck ' + k.truck_id : ''}. If it checks in again it shows up as new.`, say,
          async () => { await rpc('web_tracker_forget', { p_device: k.device_id }); route(); }, 'danger'))));
    const table = (rows, empty) => rows.length
      ? h('div', { class: 'card scroll' }, h('table', { class: 'stack users' },
          h('thead', null, h('tr', null, h('th', { text: 'Tracker' }), h('th', { text: 'Truck' }), h('th', { text: '' }))),
          h('tbody', null, rows.map(row))))
      : h('div', { class: 'empty', text: empty });
    app.replaceChildren(
      h('h1', { class: 'title', text: 'Trackers' }),
      h('p', { class: 'lede', text: 'Every tracker board that has checked in. All boards run the same firmware: a new one joins FarberGuest (or its setup hotspot, or cellular), shows up under “Waiting for a truck”, and sets itself up within a minute of being assigned.' }),
      h('div', { class: 'toolbar' }, h('a', { class: 'btn ghost', href: '#trackersettings', text: 'Fleet tracker settings' })),
      status,
      h('div', { class: 'section-head' }, h('h2', { text: `Waiting for a truck (${waiting.length})` })),
      table(waiting, 'No new trackers. Power one up near FarberGuest and it appears here.'),
      h('div', { class: 'section-head' }, h('h2', { text: `On trucks (${assigned.length})` })),
      table(assigned, 'No trackers are on trucks yet. Trackers set up with the older firmware appear here after they update.'));
  };

  // Settings shown in friendly units; stored as the tracker uses them.
  const TS_GROUPS = [
    ['Reporting schedule', [
      { k: 'wifi_send_s', label: 'On Wi-Fi, send every', unit: 'seconds', mul: 1, lo: 10, hi: 3600 },
      { k: 'cell_send_s', label: 'On cellular, send every', unit: 'minutes', mul: 60, lo: 60, hi: 86400 },
      { k: 'parked1_after_h', label: 'Parked: slow down after', unit: 'hours', mul: 1, lo: 1, hi: 720 },
      { k: 'parked1_send_s', label: '…then send every', unit: 'minutes', mul: 60, lo: 60, hi: 86400 },
      { k: 'parked2_after_h', label: 'Parked longer: slow down after', unit: 'hours', mul: 1, lo: 1, hi: 720 },
      { k: 'parked2_send_s', label: '…then send every', unit: 'minutes', mul: 60, lo: 60, hi: 86400 },
      { k: 'move_m', label: 'Counts as moving after', unit: 'feet', mul: 0.3048, lo: 20, hi: 5000, dbDigits: 0, uiDigits: 0 },
      { k: 'move_kmh', label: 'or going faster than', unit: 'mph', mul: 1.609344, lo: 2, hi: 50, dbDigits: 1, uiDigits: 1 }]],
    ['Backup battery', [
      { k: 'batt_low_v', label: 'Send a last message and sleep below', unit: 'volts', mul: 1, lo: 3.0, hi: 4.1, dbDigits: 2, uiDigits: 2 },
      { k: 'batt_critical_v', label: 'Stop the daily check-ins below', unit: 'volts', mul: 1, lo: 2.9, hi: 4.0, dbDigits: 2, uiDigits: 2 },
      { k: 'batt_resume_v', label: 'Wake up again at', unit: 'volts', mul: 1, lo: 3.3, hi: 4.2, dbDigits: 2, uiDigits: 2 },
      { k: 'checkin_h', label: 'While asleep, check in every', unit: 'hours', mul: 1, lo: 1, hi: 168 }]],
    ['Connection and sensors', [
      { k: 'apn', label: 'Cellular APN', text: true, hint: 'From the SIM provider. Empty = network default.' },
      { k: 'prefer_lte', label: 'Use cellular even when Wi-Fi works', bool: ['No', 'Yes'] },
      { k: 'wifi_on_battery', label: 'Wi-Fi when the tracker is on its backup battery', bool: ['Off (saves power)', 'On (for testing)'],
        hint: 'Normally Wi-Fi turns off when the tracker isn’t being charged. Turn on for bench testing.' },
      { k: 'obd', label: 'Read the truck’s OBD-II port', bool: ['Off', 'On'], hint: 'Turn on once a CAN transceiver is wired in.' },
      { k: 'ap_password', label: 'New setup hotspot password', text: true, pw: true, truckOnly: true,
        hint: 'Leave empty to keep the password on the tracker’s sticker. 8 to 63 characters; the tracker switches on its next send.' }]],
    ['Server (advanced)', [
      { k: 'server_url', label: 'Server address', text: true, fleetOnly: true, wide: true,
        hint: 'Only to move every tracker to a new database. Trackers try it and go back to the current one if it doesn’t work.' },
      { k: 'server_key', label: 'Server publishable key', text: true, fleetOnly: true, wide: true,
        hint: 'The publishable (public) key of the new server. Never a secret key.' }]]];
  const toUi = (f, v) => (!present(v) ? '' : f.bool ? String(v) : f.text ? String(v) : String(+(Number(v) / f.mul).toFixed(f.uiDigits ?? 1)));
  const toDb = (f, s) => {
    if (f.bool) return s === '' ? null : s === 'true';
    if (f.text) return s;
    const n = Number(s) * f.mul;
    return +n.toFixed(f.dbDigits ?? 0);
  };
  const uiRange = (f) => [toUi(f, f.lo), toUi(f, f.hi)];

  const renderTrackerSettings = async (r, token) => {
    const truck = r.id;
    const d = await rpc('web_tracker_settings', { p_truck: truck || null });
    if (token !== renderToken) return;
    const fleet = d.fleet || {};
    const mine = truck ? (d.truck || {}) : fleet;
    const inputs = {};
    const fieldFor = (f) => {
      const id = 'ts-' + f.k;
      const fleetUi = toUi(f, fleet[f.k]);
      let input;
      if (f.bool) {
        input = h('select', { id },
          truck ? h('option', { value: '', text: 'Fleet setting (' + (fleet[f.k] ? f.bool[1] : f.bool[0]) + ')' }) : null,
          h('option', { value: 'false', text: f.bool[0] }), h('option', { value: 'true', text: f.bool[1] }));
        input.value = present(mine[f.k]) ? String(mine[f.k]) : (truck ? '' : 'false');
      } else {
        input = h('input', { id, type: f.text ? (f.pw ? 'password' : 'text') : 'number', step: 'any', inputmode: f.text ? null : 'decimal',
          autocomplete: 'off', maxlength: f.text ? (f.k === 'server_key' ? '400' : f.k === 'server_url' ? '120' : '63') : null,
          placeholder: f.truckOnly ? 'Keep the password on the sticker' : f.k === 'server_url' ? 'https://xxxx.supabase.co' : truck ? (present(fleet[f.k]) && fleet[f.k] !== '' ? 'Fleet: ' + fleetUi : 'Fleet setting') : '' });
        input.value = toUi(f, mine[f.k]);
      }
      inputs[f.k] = input;
      let box = input;
      if (f.pw) {
        const t = h('button', { type: 'button', class: 'pw-toggle', text: 'Show', onclick: () => { const s = input.type === 'password'; input.type = s ? 'text' : 'password'; t.textContent = s ? 'Hide' : 'Show'; } });
        box = h('div', { class: 'pw-wrap' }, input, t);
      }
      return h('div', { class: 'field' + (f.wide ? ' wide' : '') }, h('label', { for: id, text: f.label + (f.unit ? ` (${f.unit})` : '') }), box,
        f.hint ? h('p', { class: 'note', text: f.hint }) : null);
    };

    // Wi-Fi networks: the truck's own (tried first), or the fleet's
    const wifiRows = h('div', { class: 'wifi-rows' });
    const addWifi = (n) => {
      const ssid = h('input', { type: 'text', maxlength: '32', placeholder: 'Network name', 'aria-label': 'Network name', value: n ? n.ssid : '' });
      const pass = h('input', { type: 'password', maxlength: '63', placeholder: 'Password (empty if open)', 'aria-label': 'Password', autocomplete: 'off', value: n ? n.pass : '' });
      const show = h('button', { type: 'button', class: 'pw-toggle', text: 'Show', onclick: () => { const s = pass.type === 'password'; pass.type = s ? 'text' : 'password'; show.textContent = s ? 'Hide' : 'Show'; } });
      const row = h('div', { class: 'wifi-row' }, ssid, h('div', { class: 'pw-wrap' }, pass, show),
        h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove network', text: '×', onclick: () => { row.remove(); addBtn.disabled = false; refresh(); } }));
      row.get = () => ({ ssid: ssid.value.trim(), pass: pass.value });
      wifiRows.append(row);
      addBtn.disabled = wifiRows.children.length >= 5;
    };
    const addBtn = h('button', { type: 'button', class: 'btn ghost small', text: '+ Add a network', onclick: () => { addWifi(); refresh(); } });
    (mine.wifi || []).forEach(addWifi);

    const collect = () => {
      const out = {};
      for (const [, fields] of TS_GROUPS) for (const f of fields) {
        if (!inputs[f.k]) continue;
        const v = inputs[f.k].value.trim();
        if (f.text) { if (v !== '' || (!truck && f.k === 'apn')) out[f.k] = v; continue; }
        if (v === '') continue;
        out[f.k] = toDb(f, v);
      }
      const nets = [...wifiRows.children].map((r2) => r2.get()).filter((n) => n.ssid);
      if (nets.length) out.wifi = nets;
      return out;
    };
    const problems = () => {
      const p = [];
      for (const [, fields] of TS_GROUPS) for (const f of fields) {
        if (!inputs[f.k]) continue;
        const v = inputs[f.k].value.trim();
        if (f.bool || v === '') { if (!truck && v === '' && !f.text && !f.bool) p.push(`${f.label}: needs a value.`); continue; }
        if (f.text) {
          if (f.pw && (v.length < 8 || v.length > 63)) p.push('Setup hotspot password must be 8 to 63 characters.');
          if (f.k === 'server_url' && !/^https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?\/?$/.test(v)) p.push('Server address must look like https://xxxx.supabase.co');
          if (f.k === 'server_key' && /^sb_secret_|service_role/i.test(v)) p.push('That is a secret key. Use the publishable key; secret keys must never go on a tracker.');
          continue;
        }
        const db = toDb(f, v);
        if (!Number.isFinite(db) || db < f.lo || db > f.hi) { const [a, b] = uiRange(f); p.push(`${f.label} must be between ${a} and ${b} ${f.unit}.`); }
      }
      for (const n of [...wifiRows.children].map((r2) => r2.get())) {
        if (n.ssid && n.pass && (n.pass.length < 8 || n.pass.length > 63)) p.push(`Password for “${n.ssid}” must be 8 to 63 characters, or empty for an open network.`);
        if (!n.ssid && n.pass) p.push('A Wi-Fi password has no network name.');
      }
      return p;
    };

    let start = '';
    const snap = () => JSON.stringify(collect());
    const status = h('span', { class: 'status', 'aria-live': 'polite' });
    const save = h('button', { class: 'btn', type: 'submit', text: 'Save settings' });
    const undo = h('button', { class: 'btn ghost', type: 'button', text: 'Undo changes', onclick: () => route() });
    const refresh = () => {
      const dirty = snap() !== start;
      save.disabled = !dirty; undo.disabled = !dirty;
      status.className = 'status ' + (dirty ? 'dirty' : '');
      status.textContent = dirty ? 'Changes not saved yet' : '';
    };
    unsaved.dirty = () => snap() !== start;

    const k = d.tracker;
    const intro = truck
      ? [h('p', { class: 'lede', text: `Leave a box empty to use the fleet setting (shown greyed out). Wi-Fi networks here are tried before the fleet’s.` }),
        h('div', { class: 'notice ' + (!k ? 'bad' : d.current ? 'good' : '') },
          !k ? 'No tracker on this truck checks in with the new firmware yet. These settings wait until one does.'
            : `Tracker ${k.device_id}, last checked in ${ago(minsSince(k.last_seen))}. ` + (d.current ? 'It has these settings.'
              : 'Saved changes reach it on its next send' + (d.report_interval_s ? ` (it sends every ${fmtEvery(d.report_interval_s)}).` : '.')))]
      : [h('p', { class: 'lede', text: 'Used by every tracker unless its truck has its own setting. Changes reach each tracker on its next send.' }),
        d.fleet_updated_by ? h('p', { class: 'note', text: `Last changed by ${d.fleet_updated_by}, ${fmtTime(d.fleet_updated_at)}.` }) : null];

    const form = h('form', { class: 'form', novalidate: true },
      h('fieldset', null, h('legend', { text: truck ? 'This truck’s Wi-Fi networks' : 'Wi-Fi networks for every tracker' }),
        h('p', { class: 'note', style: 'margin-bottom:8px', text: truck ? 'Usually the truck’s own Wi-Fi. Up to 5.'
          : 'Up to 5. FarberGuest (open) is the starting network. Networks typed on a tracker’s setup page are kept on that tracker too.' }),
        wifiRows, addBtn),
      TS_GROUPS.map(([name, fields]) => {
        const shown = fields.filter((f) => !(f.truckOnly && !truck) && !(f.fleetOnly && truck));
        return shown.length ? h('fieldset', null, h('legend', { text: name }), h('div', { class: 'grid' }, shown.map(fieldFor))) : null;
      }),
      h('div', { class: 'actions sticky' }, save, undo, status));
    start = snap();
    refresh();
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = problems();
      if (p.length) { status.className = 'status bad'; status.textContent = p.join(' '); return; }
      save.disabled = true; status.className = 'status busy'; status.textContent = 'Saving…';
      try {
        await rpc('web_tracker_settings_save', { p_truck: truck || null, p_settings: collect() });
        unsaved.dirty = () => false;
        await route();
        const st = document.querySelector('.actions .status');
        if (st) { st.className = 'status ok'; st.textContent = 'Saved'; }
      } catch (err) { status.className = 'status bad'; status.textContent = 'Not saved: ' + friendly(err); save.disabled = false; }
    });
    app.replaceChildren(
      h('a', { class: 'back', href: truck ? '#truck-' + encodeURIComponent(truck) : '#trackers', text: truck ? '← Truck ' + truck : '← Trackers' }),
      h('h1', { class: 'title', text: truck ? `Tracker settings · ${truck}` : 'Fleet tracker settings' }),
      ...intro,
      truck ? h('p', { class: 'note' }, h('a', { href: '#trackersettings', text: 'Fleet tracker settings →' })) : null,
      form);
  };

  // ---------- edit and add trucks (admin)
  let editCache = null;
  const loadEditData = async () => { editCache = await rpc('web_edit_data'); return editCache; };

  const renderEditList = async (r, token) => {
    const data = await loadEditData();
    if (token !== renderToken) return;
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search number, name or contact', 'aria-label': 'Search trucks' });
    const list = h('div', { class: 'list' });
    const draw = () => {
      const q = clean(search.value).toLowerCase();
      const rows = data.trucks.filter((t) => !q || [t.truck_id, t.name, t.company, t.contact_name, t.city].some((v) => String(v || '').toLowerCase().includes(q)));
      list.replaceChildren(...(rows.length ? rows.map((t) => h('a', { class: 'row', href: '#edit-' + encodeURIComponent(t.truck_id) },
        h('span', { class: 'plate', text: t.truck_id }),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-name' + (t.name ? '' : ' unnamed'), text: t.name || 'No name set' }),
          h('span', { class: 'row-sub', text: [t.company, [t.city, t.state].filter(Boolean).join(', '), t.contact_name].filter(Boolean).join(' · ') || 'No company, contact or address yet' })),
        h('span', { class: 'row-side' }, h('span', { class: 'note', text: 'Edit →' })))) : [h('div', { class: 'empty', text: 'No trucks match that search.' })]));
    };
    search.addEventListener('input', draw);
    draw();
    app.replaceChildren(
      h('h1', { class: 'title', text: 'Edit trucks' }),
      h('p', { class: 'lede', text: 'Pick a truck to change its name, build and delivery dates, address, contact and Farber team.' }),
      h('div', { class: 'toolbar' }, search, h('a', { class: 'btn', href: '#new', text: '+ Add a truck' })),
      list);
  };

  const renderEditor = async (r, token) => {
    const isNew = r.page === 'new';
    const data = await loadEditData();
    if (token !== renderToken) return;
    const TEMP_DEFAULTS = ['Chassis battery compartment', 'Aux battery compartment', 'Rack', 'Front room', 'Mid room', 'Rear room'];
    const t = isNew ? { truck_id: '', country: 'USA', team: {}, ...Object.fromEntries(TEMP_DEFAULTS.map((d, i) => ['temp' + (i + 1) + '_label', d])) }
      : data.trucks.find((x) => x.truck_id === r.id);
    if (!t) { app.replaceChildren(h('a', { class: 'back', href: '#edit', text: '← All trucks' }), h('div', { class: 'empty', text: `There is no truck ${r.id}.` })); return; }
    const inputs = {};
    const mk = (key, label, attrs, wide) => {
      const f = field(label, { autocomplete: 'off', ...attrs });
      f.input.value = (key.endsWith('_date') ? (t[key] || '') : (t[key] || ''));
      inputs[key] = f.input;
      if (wide) f.wrap.classList.add('wide');
      return f.wrap;
    };
    const selects = {};
    const teamFields = ROLE_FIELDS.map(([role, label]) => {
      const id = 'r-' + role;
      const chosen = t.team && t.team[role] ? String(t.team[role]) : '';
      const people = data.staff.filter((s) => (s.active && ROLE_FITS[role](s)) || String(s.id) === chosen);
      const sel = h('select', { id }, h('option', { value: '', text: '— Not assigned —' }),
        people.map((s) => h('option', { value: String(s.id), text: s.active ? s.name : s.name + ' (inactive)' })));
      sel.value = chosen;
      selects[role] = sel;
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), sel);
    });
    // Systems: what this truck has. New trucks start with just the engine.
    const sys0 = t.systems || { engine: true, plumbing: {}, jacks: false, solar: false, shore_amps: 0, slideouts: [], generators: [], awnings: [] };
    const chk = (label, on, hint) => {
      const id = 's-' + Math.random().toString(36).slice(2, 8);
      const box = h('input', { type: 'checkbox', id });
      box.checked = !!on;
      return { box, wrap: h('label', { class: 'check', for: id }, box, h('span', { text: label }), hint ? h('span', { class: 'note', text: ' ' + hint }) : null) };
    };
    const sysEngine = chk('Truck engine', sys0.engine, '(off for trailers)');
    const sysTank = { fresh: chk('Fresh tank', sys0.plumbing && sys0.plumbing.fresh), gray: chk('Gray tank', sys0.plumbing && sys0.plumbing.gray),
      black: chk('Black tank', sys0.plumbing && sys0.plumbing.black), jug: chk('Jug system', sys0.plumbing && sys0.plumbing.jug) };
    sysTank.jug.wrap.title = 'Fresh water from jugs instead of a tank';
    const sysJacks = chk('Leveling jacks', sys0.jacks);
    const sysSolar = chk('Solar', sys0.solar);
    const shoreSel = h('select', { id: 's-shore' }, SHORE_AMPS.map((a) => h('option', { value: String(a), text: a ? a + ' A' : 'None' })));
    shoreSel.value = String(sys0.shore_amps || 0);
    // off-grid battery system: type and capacity
    const batSel = h('select', { id: 's-battery' }, h('option', { value: '', text: 'None' }), BATTERY_TYPES.map((x) => h('option', { value: x, text: x })));
    batSel.value = (sys0.battery && sys0.battery.type) || '';
    const batAh = h('input', { type: 'number', id: 's-battery-ah', min: '0', max: '20000', step: '10', placeholder: 'Capacity', 'aria-label': 'Battery capacity in amp-hours',
      value: sys0.battery && sys0.battery.ah ? String(sys0.battery.ah) : '' });
    const batAhWrap = h('div', { class: 'with-unit' }, batAh, h('span', { class: 'unit-tag', text: 'Ah' }));
    const syncBat = () => { batAhWrap.hidden = !batSel.value; };
    batSel.addEventListener('change', syncBat); syncBat();
    // a count (0..max) and a name box for each unit
    const named = (label, unit, max, names) => {
      const id = 's-' + unit.toLowerCase();
      const sel = h('select', { id }, Array.from({ length: max + 1 }, (_, i) => h('option', { value: String(i), text: String(i) })));
      sel.value = String((names || []).length);
      const boxes = h('div', { class: 'name-boxes' });
      const kept = [...(names || [])];
      const draw = () => {
        [...boxes.children].forEach((inp, i) => { kept[i] = inp.value; });
        const n = Number(sel.value);
        boxes.replaceChildren(...Array.from({ length: n }, (_, i) => h('input', { type: 'text', maxlength: '40', 'aria-label': `${unit} ${i + 1} name`,
          placeholder: `${unit} ${i + 1}`, value: kept[i] || '' })));
      };
      sel.addEventListener('change', draw);
      draw();
      return { get: () => [...boxes.children].map((inp, i) => clean(inp.value) || `${unit} ${i + 1}`),
        wrap: h('div', { class: 'sys-group' }, h('div', { class: 'sys-count' }, h('label', { class: 'sys-head', for: id, text: label }), sel), boxes) };
    };
    const sysSlides = named('Slideouts', 'Slideout', 6, sys0.slideouts);
    const sysGens = named('Generators', 'Generator', 2, sys0.generators);
    const sysAwnings = named('Awnings', 'Awning', 6, sys0.awnings);
    const sysGet = () => ({ engine: sysEngine.box.checked,
      plumbing: Object.fromEntries(Object.entries(sysTank).map(([k, c]) => [k, c.box.checked])),
      jacks: sysJacks.box.checked, solar: sysSolar.box.checked, shore_amps: Number(shoreSel.value),
      battery: batSel.value ? { type: batSel.value, ah: batAh.value ? Math.round(Number(batAh.value)) : null } : null,
      slideouts: sysSlides.get(), generators: sysGens.get(), awnings: sysAwnings.get() });
    const systemsSet = h('fieldset', null, h('legend', { text: 'Systems' }),
      h('p', { class: 'note', style: 'margin-bottom:8px', text: 'What this truck has. It decides what the website shows and what the truck’s tracker reads and sends.' }),
      h('div', { class: 'sys-row' },
        h('div', { class: 'sys-group' }, h('span', { class: 'sys-head', text: 'Vehicle' }), sysEngine.wrap),
        h('div', { class: 'sys-group' }, h('span', { class: 'sys-head', text: 'Plumbing' }), h('div', { class: 'checks' }, Object.values(sysTank).map((c) => c.wrap))),
        h('div', { class: 'sys-group' }, h('span', { class: 'sys-head', text: 'Equipment' }), h('div', { class: 'checks' }, sysJacks.wrap, sysSolar.wrap)),
        h('div', { class: 'sys-group' }, h('label', { class: 'sys-head', for: 's-shore', text: 'Shore power' }), shoreSel),
        h('div', { class: 'sys-group' }, h('label', { class: 'sys-head', for: 's-battery', text: 'Off-grid batteries' }), batSel, batAhWrap)),
      h('p', { class: 'note sys-sub', text: 'Pick how many, then name each one (the names show on the truck page).' }),
      h('div', { class: 'sys-row' }, sysSlides.wrap, sysGens.wrap, sysAwnings.wrap));

    const nums = data.trucks.map((x) => Number(x.truck_id)).filter((n) => Number.isInteger(n) && n > 0);
    const idField = isNew ? field('Truck number', { autocomplete: 'off', inputmode: 'numeric', maxlength: '32' }) : null;
    if (idField) idField.input.value = nums.length ? String(Math.max(...nums) + 1) : '';

    const snapshot = () => JSON.stringify({ v: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'date' ? el.value : clean(el.value)])),
      team: Object.fromEntries(Object.entries(selects).map(([k, el]) => [k, el.value])), systems: sysGet() });
    let start = '';
    const status = h('span', { class: 'status', 'aria-live': 'polite' });
    const save = h('button', { class: 'btn', type: 'submit', text: isNew ? 'Add truck' : 'Save changes' });
    const undo = h('button', { class: 'btn ghost', type: 'button', text: 'Undo changes', onclick: () => route() });
    const refresh = () => {
      const dirty = snapshot() !== start;
      undo.disabled = !dirty;
      if (isNew) save.disabled = !ID_OK.test(clean(idField.input.value));
      else save.disabled = !dirty;
      status.className = 'status ' + (dirty ? 'dirty' : '');
      status.textContent = dirty && !isNew ? 'Changes not saved yet' : '';
    };
    unsaved.dirty = () => snapshot() !== start;

    const created = h('div', { class: 'notice good', hidden: true });
    const form = h('form', { class: 'form', novalidate: true },
      h('fieldset', null, h('legend', { text: 'Truck' }), h('div', { class: 'grid' },
        idField ? (idField.wrap.classList.add('wide'), idField.wrap) : null,
        mk('name', 'Name', { maxlength: '64', placeholder: 'No name set' }, true),
        mk('build_date', 'Build date', { type: 'date' }), mk('delivery_date', 'Delivery date', { type: 'date' }))),
      systemsSet,
      h('fieldset', null, h('legend', { text: 'Address' }), h('div', { class: 'grid' },
        mk('company', 'Company', { maxlength: '120' }, true),
        mk('address_line1', 'Street', { maxlength: '120' }, true), mk('address_line2', 'Building, suite or unit', { maxlength: '120' }, true),
        mk('city', 'City', { maxlength: '80' }), mk('state', 'State', { maxlength: '40' }), mk('postal_code', 'ZIP / postal code', { maxlength: '20' }),
        mk('country', 'Country', { maxlength: '60' }))),
      h('fieldset', null, h('legend', { text: 'Contact' }), h('div', { class: 'grid' },
        mk('contact_name', 'Name', { maxlength: '80' }), mk('contact_title', 'Title', { maxlength: '80' }),
        mk('contact_phone', 'Phone', { type: 'tel', maxlength: '40' }), mk('contact_email', 'Email', { type: 'email', maxlength: '120' }))),
      h('fieldset', null, h('legend', { text: 'Temperature sensor names' }),
        h('p', { class: 'note', style: 'margin-bottom:8px', text: 'What each of the tracker’s six temperature sensors measures on this truck. Leave a box empty to use the standard name.' }),
        h('div', { class: 'grid' }, [1, 2, 3, 4, 5, 6].map((i) => mk('temp' + i + '_label', 'Sensor ' + i, { maxlength: '40', placeholder: TEMP_DEFAULTS[i - 1] })))),
      h('fieldset', null, h('legend', { text: 'Farber team' }), h('div', { class: 'grid' }, teamFields)),
      h('div', { class: 'actions sticky' }, save, undo, status));
    start = snapshot();
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'date' ? el.value : clean(el.value)]));
      const problems = [];
      if (v.build_date && v.delivery_date && v.delivery_date < v.build_date) problems.push('Delivery date is before the build date.');
      if (v.contact_email && !EMAIL_OK.test(v.contact_email)) problems.push('The email address doesn’t look right.');
      if (batSel.value && batAh.value && !(Number(batAh.value) >= 0 && Number(batAh.value) <= 20000)) problems.push('Battery capacity must be 0 to 20,000 Ah.');
      let newId = null;
      if (isNew) {
        newId = clean(idField.input.value);
        if (!ID_OK.test(newId)) problems.push('Truck numbers can only use letters, numbers, - and _.');
        else if (data.trucks.some((x) => x.truck_id.toLowerCase() === newId.toLowerCase())) problems.push(`Truck ${newId} is already in the database.`);
      }
      if (problems.length) { status.className = 'status bad'; status.textContent = problems.join(' '); return; }
      const payload = { ...v, team: Object.fromEntries(Object.entries(selects).map(([k, el]) => [k, el.value])), systems: sysGet() };
      save.disabled = true; undo.disabled = true;
      status.className = 'status busy'; status.textContent = isNew ? 'Adding…' : 'Saving…';
      try {
        if (isNew) {
          const res = await rpc('web_truck_add', { p_truck: newId, p_data: payload });
          unsaved.dirty = () => false;
          form.hidden = true;
          created.hidden = false;
          showToken(created, res, true);
          window.scrollTo(0, 0);
        } else {
          await rpc('web_truck_save', { p_truck: t.truck_id, p_data: payload });
          unsaved.dirty = () => false;
          await route();
          const st = document.querySelector('.actions .status');
          if (st) { st.className = 'status ok'; st.textContent = 'Saved'; }
        }
      } catch (err) {
        status.className = 'status bad'; status.textContent = (isNew ? 'Not added: ' : 'Not saved: ') + friendly(err);
        refresh();
        status.className = 'status bad'; status.textContent = (isNew ? 'Not added: ' : 'Not saved: ') + friendly(err);
      }
    });

    // New tracker token for an existing truck (replaced tracker or lost token): press twice.
    let tokenArmed = false;
    const tokenBox = h('div', { class: 'notice good', hidden: true });
    const tokenBtn = h('button', { class: 'btn danger', type: 'button', text: 'Make a new tracker token' });
    const tokenStatus = h('span', { class: 'status' });
    tokenBtn.addEventListener('click', async () => {
      if (!tokenArmed) {
        tokenArmed = true;
        tokenStatus.className = 'status bad';
        tokenStatus.textContent = 'The truck’s current tracker stops being accepted until it gets the new token. Press again to make it.';
        return;
      }
      tokenBtn.disabled = true;
      tokenStatus.className = 'status busy'; tokenStatus.textContent = 'Making token…';
      try {
        const res = await rpc('web_truck_new_token', { p_truck: t.truck_id });
        tokenStatus.textContent = '';
        tokenBox.hidden = false;
        showToken(tokenBox, res, false);
      } catch (err) {
        tokenStatus.className = 'status bad'; tokenStatus.textContent = friendly(err);
        tokenBtn.disabled = false;
      }
    });

    refresh();
    app.replaceChildren(
      h('a', { class: 'back', href: '#edit', text: '← All trucks' }),
      h('h1', { class: 'title' }, isNew ? 'Add a truck' : t.truck_id, !isNew && t.name ? h('span', { class: 'sub', text: ' · ' + t.name }) : null),
      h('p', { class: 'lede', text: isNew ? 'Enter the truck number and anything else you know now; the rest can be filled in later. Adding a truck makes its tracker token.' : 'Change anything below, then press Save changes. Empty boxes are saved as blank.' }),
      created, form,
      isNew ? null : h('div', { class: 'section-head' }, h('h2', { text: 'Tracker token' })),
      isNew ? null : h('div', { class: 'card form' },
        h('p', { class: 'note', text: 'Only needed when this truck gets a new tracker or its token is lost. The token is shown once.' }),
        h('div', { class: 'actions' }, tokenBtn, tokenStatus), tokenBox));
  };

  const showToken = (box, res, isNew) => {
    const lines = `#define TRUCK_ID "${res.truck_id}"\n#define DEVICE_TOKEN "${res.token}"`;
    const copyStatus = h('span', { class: 'status' });
    const pre = h('pre', { class: 'code', text: lines });
    box.replaceChildren(
      h('strong', { text: isNew ? `Truck ${res.truck_id} added` : `New token for truck ${res.truck_id}` }),
      h('p', { text: 'Put these two lines in the tracker’s firmware/include/config.h. Save the token now: the database keeps only a scrambled copy, so it can’t be shown again.' }),
      pre,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', text: 'Copy lines', onclick: async () => {
          try { await navigator.clipboard.writeText(lines); copyStatus.textContent = 'Copied'; }
          catch (e) { const rg = document.createRange(); rg.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); copyStatus.textContent = 'Selected: use your device’s Copy'; }
        } }),
        isNew ? h('a', { href: '#truck-' + encodeURIComponent(res.truck_id), text: 'Open its page' }) : null,
        isNew ? h('a', { href: '#edit-' + encodeURIComponent(res.truck_id), text: 'Edit it' }) : null,
        copyStatus));
  };

  // ---------- service pages (placeholders; built later)
  const renderServicePage = async (r, token) => {
    if (!isServiceView()) { location.replace('#truck-' + encodeURIComponent(r.id)); return; }
    if (r.kind === 'schedule') return renderNewTicket(r, token, { heading: 'Schedule maintenance', status: 'Scheduled', category: 'Maintenance' });
    if (r.kind === 'done') return renderNewTicket(r, token, { heading: 'Add maintenance completed', status: 'Done', category: 'Maintenance' });
    const [rows, work] = await Promise.all([rpc('web_truck', { p_truck: r.id }), r.kind === 'work' ? rpc('web_truck_work', { p_truck: r.id }) : Promise.resolve([])]);
    if (token !== renderToken) return;
    const t = rows[0];
    if (!t) { app.replaceChildren(h('div', { class: 'empty', text: `There is no truck ${r.id}.` })); return; }
    if (r.kind === 'work') return renderWorkHistory(t, work);
    const blurb = {
      work: 'Every repair, service visit and maintenance job done on this truck, newest first.',
      schedule: 'Book upcoming maintenance or a service visit for this truck.',
      done: 'Record maintenance that has been finished, so the due dates on the truck page update.',
    }[r.kind];
    app.replaceChildren(
      h('a', { class: 'back', href: '#truck-' + encodeURIComponent(t.truck_id), text: '← Back to the truck page' }),
      h('p', { class: 'eyebrow', text: 'Service' }),
      h('h1', { class: 'title' }, SERVICE_PAGES[r.kind]),
      h('p', { class: 'lede' }, h('strong', { text: t.truck_id }), t.truck_name ? ' · ' + t.truck_name : ''),
      h('div', { class: 'card' },
        h('h2', { text: 'Coming soon' }),
        h('p', { class: 'muted', style: 'margin-top:6px', text: blurb + ' This page is being built.' })));
  };

  // ---------- maintenance history: every record for one truck
  const WORK_CATS = [['all', 'All'], ['Maintenance', 'Maintenance'], ['Inspection', 'Inspections'], ['Repair', 'Repairs'],
    ['Warranty', 'Warranty'], ['Breakdown', 'Breakdowns'], ['Upgrade', 'Upgrades']];
  const CAT_TONE = { Maintenance: 'ok', Inspection: 'muted', Repair: 'warn', Warranty: 'warn', Breakdown: 'bad', Upgrade: 'accent' };
  const renderWorkHistory = (t, work) => {
    let cat = 'all';
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search ticket number, work, notes, shop or place', 'aria-label': 'Search maintenance history' });
    const count = h('span', { class: 'note' });
    const tabs = h('div', { class: 'seg tabs-row', role: 'tablist', 'aria-label': 'Filter by type' });
    const tbody = h('tbody');
    const n = (k) => work.filter((w) => k === 'all' || w.category === k).length;
    const draw = () => {
      tabs.replaceChildren(...WORK_CATS.filter(([k]) => k === 'all' || n(k) > 0).map(([k, l]) =>
        h('button', { type: 'button', role: 'tab', 'aria-pressed': String(cat === k), onclick: () => { cat = k; draw(); } }, `${l} (${n(k)})`)));
      const q = clean(search.value).toLowerCase();
      const rows = work.filter((w) => (cat === 'all' || w.category === cat)
        && (!q || ['#' + w.ticket_no, w.title, w.notes, w.done_by, w.location, w.category].some((v) => String(v || '').toLowerCase().includes(q))));
      count.textContent = rows.length === work.length ? `${work.length} records` : `${rows.length} of ${work.length} records`;
      tbody.replaceChildren(...(rows.length ? rows.map((w) => h('tr', null,
        h('td', { class: 'first nowrap', 'data-label': 'Date' }, h('div', { text: fmtDay(w.done_on) }), ticketLink(w.ticket_no)),
        h('td', { 'data-label': 'Type' }, h('span', { class: 'pill ' + tagTone({ status: 'Done' }), text: w.category })),
        h('td', { 'data-label': 'Work' }, h('div', { class: 'work-title' }, h('a', { href: '#ticket-' + w.ticket_no, text: w.title })), w.notes ? h('div', { class: 'note', text: w.notes }) : null),
        h('td', { 'data-label': 'Mileage', class: 'nowrap num', text: present(w.odometer_mi) ? num(w.odometer_mi) + ' mi' : '—' }),
        h('td', { 'data-label': 'Gen hours', class: 'nowrap num', text: present(w.hours) ? num(w.hours, Number.isInteger(w.hours) ? 0 : 1) + ' h' : '—' }),
        h('td', { 'data-label': 'Done by' }, h('div', { text: w.done_by || '—' }), w.location ? h('div', { class: 'note', text: w.location }) : null)))
        : [h('tr', null, h('td', { colspan: '6', class: 'muted', text: 'Nothing matches.' }))]));
    };
    search.addEventListener('input', draw);
    draw();
    const oil = work.filter((w) => w.type_code).length;
    const fixes = work.filter((w) => w.category === 'Repair' || w.category === 'Warranty').length;
    const breakdowns = n('Breakdown');
    const last = work[0];
    app.replaceChildren(
      h('a', { class: 'back', href: '#truck-' + encodeURIComponent(t.truck_id), text: '← Back to the truck page' }),
      h('p', { class: 'eyebrow', text: 'Service' }),
      h('h1', { class: 'title' }, 'Maintenance history'),
      h('p', { class: 'lede' }, h('strong', { text: t.truck_id }), t.truck_name ? ' · ' + t.truck_name : '', t.delivery_date ? ` · delivered ${t.delivery_date}` : ''),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('h3', { text: 'Records' }), h('span', { class: 'big', text: num(work.length) }), h('span', { class: 'sub', text: last ? 'Last: ' + fmtDay(last.done_on) : 'None yet' })),
        h('div', { class: 'tile' }, h('h3', { text: 'Oil changes' }), h('span', { class: 'big', text: num(oil) }), h('span', { class: 'sub', text: 'Engine and generator' })),
        h('div', { class: 'tile' }, h('h3', { text: 'Repairs' }), h('span', { class: 'big' + (fixes ? ' warn' : ''), text: num(fixes) }), h('span', { class: 'sub', text: 'Including warranty' })),
        h('div', { class: 'tile' }, h('h3', { text: 'Breakdowns' }), h('span', { class: 'big' + (breakdowns ? ' bad' : ''), text: num(breakdowns) }), h('span', { class: 'sub', text: 'Roadside and tows' }))),
      tabs,
      h('div', { class: 'toolbar' }, search, count),
      h('div', { class: 'card scroll' }, h('table', { class: 'stack work-table' },
        h('thead', null, h('tr', null, ['Date', 'Type', 'Work', 'Mileage', 'Gen hours', 'Done by'].map((x) => h('th', { text: x })))), tbody)));
  };

  // ---------- service tickets
  const TICKET_CATS = ['Maintenance', 'Repair', 'Breakdown', 'Inspection', 'Warranty', 'Upgrade', 'Other'];
  const CUST_CATS = ['Maintenance', 'Repair', 'Breakdown', 'Inspection', 'Other'];
  const URGENCIES = ['Low', 'Normal', 'Urgent'];
  const OIL_TYPES = [['', 'No'], ['engine_oil', 'Engine oil change'], ['generator_oil', 'Generator oil change']];
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const ticketLink = (no, text) => h('a', { class: 'ticket-no', href: '#ticket-' + no, text: text || '#' + no });
  // small form helpers that keep line breaks in text areas
  const fId = () => 'f-' + Math.random().toString(36).slice(2, 8);
  const inF = (label, value, attrs) => { const id = fId(); const input = h('input', { id, autocomplete: 'off', ...attrs }); input.value = value ?? ''; return { wrap: h('div', { class: 'field' }, h('label', { for: id, text: label }), input), input }; };
  const selF = (label, opts, value) => { const id = fId(); const input = h('select', { id }, opts.map((o) => Array.isArray(o) ? h('option', { value: o[0], text: o[1] }) : h('option', { value: o, text: o }))); input.value = value ?? ''; return { wrap: h('div', { class: 'field' }, h('label', { for: id, text: label }), input), input }; };
  const areaF = (label, value, attrs) => { const id = fId(); const input = h('textarea', { id, rows: '4', ...attrs }); input.value = value ?? ''; return { wrap: h('div', { class: 'field wide' }, h('label', { for: id, text: label }), input), input }; };

  // Service users and admins: create (k null) or edit a ticket
  const ticketEditor = (k, opts) => {
    const isNew = !k;
    const v = k || opts.preset || {};
    let truckSel = null;
    if (isNew && !v.truck_id) {
      truckSel = selF('Truck', [['', 'Choose a truck…'], ...(opts.trucks || []).map((t) => [t.truck_id, t.truck_id + (t.truck_name ? ' · ' + t.truck_name : '')])], '');
    }
    const f = {
      title: inF('Title', v.title, { maxlength: '160', placeholder: 'What needs doing' }),
      category: selF('Type', TICKET_CATS, v.category || 'Repair'),
      system: selF('System', [], ''),
      urgency: selF('Urgency', URGENCIES, v.urgency || 'Normal'),
      details: areaF('Request / problem', v.details, { maxlength: '4000' }),
      status: selF('Status', REQ_STATUS, v.status || 'New'),
      scheduled_for: inF('Scheduled for', v.scheduled_for, { type: 'date' }),
      assigned_to: inF('Assigned to', v.assigned_to, { maxlength: '120', placeholder: 'Who is doing the work' }),
      done_on: inF('Done on', v.done_on, { type: 'date' }),
      done_by: inF('Done by', v.done_by, { maxlength: '120' }),
      location: inF('Where', v.location, { maxlength: '160' }),
      odometer_mi: inF('Mileage (mi)', v.odometer_mi, { type: 'number', min: '0', step: '1' }),
      hours: inF('Generator hours', v.hours, { type: 'number', min: '0', step: '0.1' }),
      type_code: selF('Counts as an oil change', OIL_TYPES, v.type_code || ''),
      work_done: areaF('Work done', v.work_done, { maxlength: '4000' }),
      truck_location: inF('Truck location', v.truck_location, { maxlength: '300', placeholder: 'Address, yard or GPS description' }),
      req_contact_name: inF('Contact name', v.req_contact_name, { maxlength: '120' }),
      req_contact_role: inF('Role', v.req_contact_role, { maxlength: '80' }),
      req_contact_phone: inF('Phone', v.req_contact_phone, { type: 'tel', maxlength: '40' }),
      req_contact_email: inF('Email', v.req_contact_email, { type: 'email', maxlength: '160' }),
    };
    f.truck_location.wrap.classList.add('wide');
    f.type_code.wrap.title = 'Oil changes reset the due date on the truck page';
    // System choices follow the truck (and change when another truck is picked)
    const sysFor = (id) => (id && opts.trucks ? ((opts.trucks.find((x) => x.truck_id === id) || {}).systems) : null) || v.truck_systems || null;
    fillSystemSelect(f.system.input, sysFor(v.truck_id), v.system || '');
    if (truckSel) truckSel.input.addEventListener('change', () => fillSystemSelect(f.system.input, sysFor(truckSel.input.value), f.system.input.value));
    const snap = () => JSON.stringify(Object.fromEntries(Object.entries(f).map(([key, x]) => [key, x.input.value]).concat([['truck', truckSel ? truckSel.input.value : '']])));
    const start = snap();
    unsaved.dirty = () => snap() !== start;
    f.status.input.addEventListener('change', () => { if (f.status.input.value === 'Done' && !f.done_on.input.value) f.done_on.input.value = todayIso(); });
    const st = h('span', { class: 'status', 'aria-live': 'polite' });
    const btn = h('button', { class: 'btn', type: 'submit', text: isNew ? 'Create ticket' : 'Save changes' });
    const form = h('form', { class: 'card form ticket-form', novalidate: true },
      h('fieldset', null, h('legend', { text: 'Request' }), h('div', { class: 'grid' },
        truckSel ? (truckSel.wrap.classList.add('wide'), truckSel.wrap) : null,
        (f.title.wrap.classList.add('wide'), f.title.wrap), f.category.wrap, f.system.wrap, f.urgency.wrap, f.details.wrap)),
      h('fieldset', null, h('legend', { text: 'Truck location and contact' }), h('div', { class: 'grid' },
        f.truck_location.wrap, f.req_contact_name.wrap, f.req_contact_role.wrap, f.req_contact_phone.wrap, f.req_contact_email.wrap)),
      h('fieldset', null, h('legend', { text: 'Status and scheduling' }), h('div', { class: 'grid' },
        f.status.wrap, f.scheduled_for.wrap, f.assigned_to.wrap)),
      h('fieldset', null, h('legend', { text: 'Work done' }), h('div', { class: 'grid' },
        f.done_on.wrap, f.done_by.wrap, f.location.wrap, f.odometer_mi.wrap, f.hours.wrap, f.type_code.wrap, f.work_done.wrap)),
      h('div', { class: 'actions' }, btn, st));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(Object.entries(f).map(([key, x]) => [key, String(x.input.value).trim()]));
      data.truck_id = truckSel ? truckSel.input.value : v.truck_id;
      if (isNew && v.warning_key) data.warning_key = v.warning_key;
      if (!data.truck_id) { st.className = 'status bad'; st.textContent = 'Pick a truck.'; return; }
      if (!data.title) { st.className = 'status bad'; st.textContent = 'Give the ticket a title.'; f.title.input.focus(); return; }
      btn.disabled = true; st.className = 'status busy'; st.textContent = 'Saving…';
      try {
        const res = await rpc('web_ticket_save', { p_no: isNew ? null : k.ticket_no, p_data: data });
        unsaved.dirty = () => false;
        if (isNew) location.hash = '#ticket-' + res.ticket_no; else route();
      } catch (err) { st.className = 'status bad'; st.textContent = friendly(err); btn.disabled = false; }
    });
    return form;
  };

  const notesCard = (k) => {
    const box = areaF('Add a note for the team', '', { rows: '3', maxlength: '4000', placeholder: 'Calls, parts ordered, what you found…' });
    const st = h('span', { class: 'status', 'aria-live': 'polite' });
    const btn = h('button', { class: 'btn', type: 'submit', text: 'Add note' });
    const form = h('form', { class: 'note-form', novalidate: true }, box.wrap, h('div', { class: 'actions' }, btn, st));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = box.input.value.trim();
      if (!body) { st.className = 'status bad'; st.textContent = 'Type a note first.'; return; }
      btn.disabled = true; st.className = 'status busy'; st.textContent = 'Adding…';
      try { await rpc('web_ticket_note', { p_no: k.ticket_no, p_body: body }); unsaved.dirty = () => false; route(); }
      catch (err) { st.className = 'status bad'; st.textContent = friendly(err); btn.disabled = false; }
    });
    const notes = k.notes || [];
    return h('div', { class: 'card notes' },
      h('h2', { text: 'Team notes' }),
      h('p', { class: 'note', text: 'Farber Service, Sales and admins see these; customers don’t. Every change to the ticket is added automatically with who made it.' }),
      notes.length ? h('ol', { class: 'note-list' }, notes.map((n) => h('li', { class: 'note-item' + (n.kind === 'change' ? ' change' : '') },
        h('div', { class: 'note-head' }, h('strong', { text: n.author || 'Farber' }), h('span', { class: 'note', text: fmtTime(n.at) })),
        h('div', { class: 'note-body', text: n.body }))))
        : h('p', { class: 'muted', text: 'No notes yet.' }),
      form);
  };

  const contactPanel = (k) => panel('Truck location and contact',
    h('div', { class: 'kv' }, h('span', { text: 'Truck location' }), k.truck_location
      ? (present(k.truck_lat) ? h('a', { href: mapUrl(k.truck_lat, k.truck_lon), target: '_blank', rel: 'noopener', text: k.truck_location }) : h('b', { text: k.truck_location }))
      : h('b', { text: '—' })),
    kv('Contact', [k.req_contact_name, k.req_contact_role].filter(Boolean).join(', ') || null),
    h('div', { class: 'kv' }, h('span', { text: 'Phone' }), k.req_contact_phone ? h('a', { href: 'tel:' + String(k.req_contact_phone).replace(/[^0-9+]/g, ''), text: k.req_contact_phone }) : h('b', { text: '—' })),
    h('div', { class: 'kv' }, h('span', { text: 'Email' }), k.req_contact_email ? h('a', { href: 'mailto:' + k.req_contact_email, text: k.req_contact_email }) : h('b', { text: '—' })));

  // quick status buttons (Service users and admins)
  const statusActions = (k) => {
    const open = ['New', 'Scheduled', 'In progress'].includes(k.status);
    const st = h('span', { class: 'status', 'aria-live': 'polite' });
    const panelBox = h('div', { class: 'action-panel', hidden: true });
    const run = async (action, extra, btns) => {
      btns.forEach((b) => { b.disabled = true; }); st.className = 'status busy'; st.textContent = 'Saving…';
      try { await rpc('web_ticket_status', { p_no: k.ticket_no, p_action: action, ...extra }); unsaved.dirty = () => false; route(); }
      catch (err) { st.className = 'status bad'; st.textContent = friendly(err); btns.forEach((b) => { b.disabled = false; }); }
    };
    const showPanel = (title, fields, confirmText, onConfirm, danger) => {
      const ok = h('button', { class: 'btn' + (danger ? ' danger' : ''), type: 'submit', text: confirmText });
      const back = h('button', { class: 'btn ghost', type: 'button', text: 'Back', onclick: () => { panelBox.hidden = true; st.textContent = ''; } });
      const form = h('form', { class: 'card form', novalidate: true }, h('h3', { text: title }), h('div', { class: 'grid' }, ...fields.map((x) => x.wrap)), h('div', { class: 'actions' }, ok, back));
      form.addEventListener('submit', (e) => { e.preventDefault(); onConfirm([ok, back]); });
      panelBox.replaceChildren(form); panelBox.hidden = false;
      const first = fields.find((x) => x.input.tagName !== 'SELECT'); if (first) first.input.focus();
    };
    const doneBtn = h('button', { class: 'btn', type: 'button', text: 'Mark done', onclick: () => {
      const date = inF('Done on', todayIso(), { type: 'date', max: todayIso() });
      const work = areaF('What was done', k.work_done || '', { maxlength: '4000', rows: '3', placeholder: 'Parts, findings, anything the next tech should know' });
      showPanel('Mark ticket #' + k.ticket_no + ' done', [date, work], 'Mark done', (btns) => {
        if (!date.input.value) { st.className = 'status bad'; st.textContent = 'Pick the date it was done.'; return; }
        run('done', { p_done_on: date.input.value, p_work_done: work.input.value.trim() }, btns);
      });
    } });
    const startBtn = h('button', { class: 'btn', type: 'button', text: 'Start work', onclick: (e) => run('start', {}, [e.currentTarget]) });
    const reasonPanel = (action, title, confirmText, danger) => () => {
      const why = areaF(action === 'reopen' ? 'Why is it being reopened?' : 'Why is it being cancelled?', '', { maxlength: '4000', rows: '2' });
      showPanel(title, [why], confirmText, (btns) => {
        if (!why.input.value.trim()) { st.className = 'status bad'; st.textContent = 'Give a reason. It goes in the team notes.'; why.input.focus(); return; }
        run(action, { p_reason: why.input.value.trim() }, btns);
      }, danger);
    };
    const cancelBtn = h('button', { class: 'btn ghost', type: 'button', text: 'Cancel ticket', onclick: reasonPanel('cancel', 'Cancel ticket #' + k.ticket_no, 'Cancel ticket', true) });
    const reopenBtn = h('button', { class: 'btn', type: 'button', text: 'Reopen ticket', onclick: reasonPanel('reopen', 'Reopen ticket #' + k.ticket_no, 'Reopen') });
    const btns = open
      ? [['New', 'Scheduled'].includes(k.status) ? startBtn : null, doneBtn, cancelBtn]
      : [reopenBtn];
    return h('div', { class: 'status-actions' },
      h('div', { class: 'actions' }, ...btns.filter(Boolean), st,
        !open ? h('span', { class: 'note', text: k.status === 'Done' ? `Done ${k.done_on ? fmtDay(k.done_on) : ''}. Reopening puts it back In progress${k.type_code ? ' and the oil change no longer counts until it’s marked done again' : ''}.` : 'Cancelled. Reopening puts it back In progress.' }) : null),
      panelBox);
  };

  const renderTicket = async (r, token) => {
    const no = Number(r.id);
    let k;
    try { k = await rpc('web_ticket', { p_no: no }); }
    catch (err) {
      if (/Not allowed|no ticket/i.test(err.message || '')) { app.replaceChildren(h('div', { class: 'empty', text: /no ticket/i.test(err.message) ? `There is no ticket #${no}.` : 'You can’t open this ticket.' })); return; }
      throw err;
    }
    if (token !== renderToken) return;
    // follow "View as": an admin viewing as Sales gets the Sales view; as Engineering, no ticket
    if (!isCustomer() && !canSeeTickets()) { app.replaceChildren(h('div', { class: 'empty', text: 'You can’t open this ticket.' })); return; }
    if (k.can_edit && !isServiceView()) k.can_edit = false;
    k.truck_systems = k.truck_systems || null;
    const head = [
      h('a', { class: 'back', href: k.can_note ? '#truck-' + encodeURIComponent(k.truck_id) : '#customer-' + encodeURIComponent(k.truck_id), text: k.can_note ? '← Truck ' + k.truck_id : '← Back to my truck' }),
      h('p', { class: 'eyebrow', text: 'Service ticket #' + k.ticket_no }),
      h('h1', { class: 'title', text: k.title }),
      h('div', { class: 'meta' },
        h('span', { class: 'pill ' + (REQ_TONE[k.status] || 'muted'), text: k.status }),
        h('span', { class: 'pill ' + tagTone(k, URG_TONE[k.urgency]), text: k.urgency }),
        h('span', { class: 'pill ' + tagTone(k, CAT_TONE[k.category]), text: k.category }),
        k.system ? h('span', { class: 'pill muted', text: k.system }) : null,
        h('span', { text: (k.source === 'Customer' ? 'Requested by ' + (k.requester_name || 'the customer') : 'Opened by Farber') + ' · ' + fmtTime(k.created_at) }),
        k.can_note && k.warning_key ? h('a', { class: 'why', href: '#warnings', text: 'For the warning: ' + k.warning_key }) : null),
    ];
    if (k.can_note) {
      const info = h('div', { class: 'panels' },
        panel('Truck', h('div', { class: 'kv' }, h('span', { text: 'Truck' }), h('a', { href: '#truck-' + encodeURIComponent(k.truck_id), text: k.truck_id + (k.truck_name ? ' · ' + k.truck_name : '') })),
          kv('Company', k.company), kv('Main contact', k.contact_name),
          h('div', { class: 'kv' }, h('span', { text: 'Phone' }), k.contact_phone ? h('a', { href: 'tel:' + String(k.contact_phone).replace(/[^0-9+]/g, ''), text: k.contact_phone }) : h('b', { text: '—' })),
          h('div', { class: 'kv' }, h('span', { text: 'Email' }), k.contact_email ? h('a', { href: 'mailto:' + k.contact_email, text: k.contact_email }) : h('b', { text: '—' }))),
        contactPanel(k),
        panel('Ticket', kv('Ticket number', '#' + k.ticket_no), kv('Opened', fmtTime(k.created_at)), kv('Requested by', k.requester_name || (k.source === 'Farber' ? 'Farber' : null)),
          kv('Last updated', fmtTime(k.updated_at)), kv('Updated by', k.updated_by_name || k.updated_by)));
      // Sales reads the ticket; only Service and admins edit it
      const readOnly = () => h('div', { class: 'panels one' },
        panel('Request', kv('Type', k.category), kv('System', k.system), kv('Urgency', k.urgency), k.details ? h('p', { class: 'ticket-text', text: k.details }) : h('p', { class: 'muted', text: 'No description.' })),
        panel('Status and scheduling', kv('Status', k.status), kv('Scheduled for', k.scheduled_for ? fmtDay(k.scheduled_for) : null), kv('Assigned to', k.assigned_to)),
        panel('Work done', kv('Done on', k.done_on ? fmtDay(k.done_on) : null), kv('Done by', k.done_by), kv('Where', k.location),
          kv('Mileage', present(k.odometer_mi) ? num(k.odometer_mi) + ' mi' : null), kv('Generator hours', present(k.hours) ? num(k.hours, 1) + ' h' : null),
          k.work_done ? h('p', { class: 'ticket-text', text: k.work_done }) : null));
      app.replaceChildren(...head, k.can_edit ? statusActions(k) : h('p', { class: 'note', text: 'You can read this ticket and add team notes. Only Farber Service and admins can change it.' }), info,
        h('div', { class: 'ticket-cols' }, h('div', null, h('div', { class: 'section-head' }, h('h2', { text: 'Ticket details' })), k.can_edit ? ticketEditor(k, {}) : readOnly()), notesCard(k)));
    } else {
      app.replaceChildren(...head,
        h('div', { class: 'panels' },
          panel('Your request', kv('Type', k.category), kv('Part of the truck', k.system), kv('Urgency', k.urgency), kv('Sent', fmtTime(k.created_at)), kv('Truck', k.truck_id + (k.truck_name ? ' · ' + k.truck_name : '')),
            k.details ? h('p', { class: 'ticket-text', text: k.details }) : null),
          contactPanel(k),
          panel('Status', kv('Status', k.status, null, k.status === 'Done' ? 'ok' : null), kv('Scheduled for', k.scheduled_for ? fmtDay(k.scheduled_for) : null), kv('Assigned to', k.assigned_to)),
          k.status === 'Done' || k.work_done ? panel('Work done', kv('Done on', k.done_on ? fmtDay(k.done_on) : null), kv('Done by', k.done_by),
            k.work_done ? h('p', { class: 'ticket-text', text: k.work_done }) : null) : null),
        h('p', { class: 'note', text: 'Questions about this ticket? Call Farber Service and give the ticket number #' + k.ticket_no + '.' }));
    }
  };

  // Service users and admins: new ticket (from the tickets page, or Schedule / Add maintenance completed on a truck)
  const renderNewTicket = async (r, token, preset) => {
    if (!isServiceView()) { location.replace(r.id ? '#truck-' + encodeURIComponent(r.id) : '#trucks'); return; }
    const [trows, fleet] = await Promise.all([r.id ? rpc('web_truck', { p_truck: r.id }) : Promise.resolve([]), r.id ? Promise.resolve([]) : rpc('web_fleet')]);
    if (token !== renderToken) return;
    const t = trows[0];
    if (r.id && !t) { app.replaceChildren(h('div', { class: 'empty', text: `There is no truck ${r.id}.` })); return; }
    const p = { ...preset, truck_id: t ? t.truck_id : null, truck_systems: t ? t.systems : null };
    if (t && !p.system) p.system = systemForWarning(preset.warning_key, t.systems);
    if (p.status === 'Done') { p.done_on = todayIso(); p.odometer_mi = t ? t.odometer_mi : null; p.hours = t ? t.gen_hours : null; }
    app.replaceChildren(
      h('a', { class: 'back', href: t ? '#truck-' + encodeURIComponent(t.truck_id) : '#requests', text: t ? '← Back to the truck page' : '← Service tickets' }),
      h('p', { class: 'eyebrow', text: 'Service' }),
      h('h1', { class: 'title', text: preset.heading }),
      t ? h('p', { class: 'lede' }, h('strong', { text: t.truck_id }), t.truck_name ? ' · ' + t.truck_name : '') : null,
      ticketEditor(null, { preset: p, trucks: fleet.map((x) => ({ truck_id: x.truck_id, truck_name: x.truck_name, systems: x.systems })) }));
  };

  // ---------- customer: request service (creates a ticket with the few fields a customer fills in)
  const renderRequestForm = async (r, token) => {
    // only the truck's customer sends requests; Sales doesn't get the form
    if (isSalesView()) { location.replace('#customer-' + encodeURIComponent(r.id)); return; }
    let t;
    try { t = await rpc('web_customer_truck', { p_truck: r.id }); }
    catch (err) { if (/Not allowed/i.test(err.message || '')) { location.replace(isCustomer() ? '#mytrucks' : '#trucks'); return; } throw err; }
    if (token !== renderToken) return;
    if (!t) { app.replaceChildren(h('div', { class: 'empty', text: `There is no truck ${r.id}.` })); return; }
    const cat = selF('What kind of service?', [['', 'Choose…'], ...CUST_CATS.map((c) => [c, c === 'Other' ? 'Something else' : c])], '');
    const sysPick = selF('Which part of the truck? (optional)', [], '');
    fillSystemSelect(sysPick.input, t.systems, '', 'Not sure / something else');
    const urg = selF('How urgent is it?', [['Low', 'Low: whenever convenient'], ['Normal', 'Normal: in the next week or two'], ['Urgent', 'Urgent: the truck can’t be used']], 'Normal');
    const title = inF('In a few words, what do you need?', '', { maxlength: '120', placeholder: 'For example: Oil change, A/C not cooling' });
    const details = areaF('Anything else we should know? (optional)', '', { maxlength: '2000', rows: '5', placeholder: 'What happened, when it started, where the truck is, best time to reach you…' });
    title.wrap.classList.add('wide');
    // where the truck is: its GPS position, or typed in
    const hasGps = present(t.lat);
    const gpsText = hasGps ? 'near ' + ([t.near_city, t.near_state].filter(Boolean).join(', ') || 'its last position') + ' (last report ' + ago(t.minutes_since_seen) + ')' : 'no GPS position yet';
    const radio = (val, label, extra) => { const id = fId(); const r = h('input', { type: 'radio', name: 'locmode', id, value: val }); return { r, el: h('label', { class: 'choice', for: id }, r, h('span', null, label, extra || '')) }; };
    const gpsR = radio('gps', 'Use the truck’s GPS location', h('span', { class: 'note' }, ' ', gpsText, hasGps ? ' · ' : '', hasGps ? h('a', { href: mapUrl(t.lat, t.lon), target: '_blank', rel: 'noopener', text: 'map ↗' }) : ''));
    const entR = radio('entered', 'Type where it is');
    gpsR.r.disabled = !hasGps;
    (hasGps ? gpsR : entR).r.checked = true;
    const locIn = areaF('Address or description', '', { rows: '2', maxlength: '300', placeholder: 'Street address, yard, gate or parking spot' });
    const syncLoc = () => { locIn.wrap.hidden = !entR.r.checked; };
    gpsR.r.addEventListener('change', syncLoc); entR.r.addEventListener('change', syncLoc); syncLoc();
    // who Farber should contact about this request (can be someone else)
    const cName = inF('Contact name', me.name || '', { maxlength: '120', autocomplete: 'name' });
    const cRole = inF('Role (optional)', '', { maxlength: '80', placeholder: 'Fleet manager, driver, site lead…' });
    const cPhone = inF('Phone', '', { type: 'tel', maxlength: '40', autocomplete: 'tel' });
    const cEmail = inF('Email', me.email || '', { type: 'email', maxlength: '160', autocomplete: 'email' });
    const snap = () => [cat.input.value, sysPick.input.value, title.input.value, details.input.value, locIn.input.value, cRole.input.value, cPhone.input.value].join('|');
    const start0 = snap();
    unsaved.dirty = () => snap() !== start0;
    const st = h('span', { class: 'status', 'aria-live': 'polite' });
    const preview = !isCustomer();
    const btn = h('button', { class: 'btn', type: 'submit', text: 'Send request', disabled: preview });
    const form = h('form', { class: 'card form', novalidate: true },
      h('fieldset', null, h('legend', { text: 'What do you need?' }), h('div', { class: 'grid' }, h('div', { class: 'pair' }, cat.wrap, sysPick.wrap, urg.wrap), title.wrap, details.wrap)),
      h('fieldset', null, h('legend', { text: 'Where is the truck?' }), h('div', { class: 'choices' }, gpsR.el, entR.el), locIn.wrap),
      h('fieldset', null, h('legend', { text: 'Who should Farber contact?' }),
        h('p', { class: 'note', text: 'It can be someone other than you, like a fleet manager or the driver. Give a phone number or an email (or both).' }),
        h('div', { class: 'grid' }, cName.wrap, cRole.wrap, cPhone.wrap, cEmail.wrap)),
      h('div', { class: 'actions' }, btn, st));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (preview) return;
      if (!cat.input.value) { st.className = 'status bad'; st.textContent = 'Choose what kind of service you need.'; return; }
      if (!title.input.value.trim()) { st.className = 'status bad'; st.textContent = 'Say briefly what you need.'; title.input.focus(); return; }
      const mode = gpsR.r.checked ? 'gps' : 'entered';
      if (mode === 'entered' && !locIn.input.value.trim()) { st.className = 'status bad'; st.textContent = 'Type where the truck is.'; locIn.input.focus(); return; }
      if (!cName.input.value.trim()) { st.className = 'status bad'; st.textContent = 'Give a contact name.'; cName.input.focus(); return; }
      if (!cPhone.input.value.trim() && !cEmail.input.value.trim()) { st.className = 'status bad'; st.textContent = 'Give a phone number or email for the contact.'; cPhone.input.focus(); return; }
      if (cEmail.input.value.trim() && !EMAIL_OK.test(cEmail.input.value.trim())) { st.className = 'status bad'; st.textContent = 'That email address doesn’t look right.'; cEmail.input.focus(); return; }
      btn.disabled = true; st.className = 'status busy'; st.textContent = 'Sending…';
      try {
        const res = await rpc('web_customer_ticket_create', { p_truck: t.truck_id, p_category: cat.input.value, p_title: title.input.value.trim(), p_details: details.input.value.trim(), p_urgency: urg.input.value,
          p_location_mode: mode, p_location: mode === 'entered' ? locIn.input.value.trim() : null,
          p_contact_name: cName.input.value.trim(), p_contact_role: cRole.input.value.trim(), p_contact_phone: cPhone.input.value.trim(), p_contact_email: cEmail.input.value.trim(),
          p_system: sysPick.input.value || null });
        unsaved.dirty = () => false;
        location.hash = '#ticket-' + res.ticket_no;
      } catch (err) { st.className = 'status bad'; st.textContent = friendly(err); btn.disabled = false; }
    });
    app.replaceChildren(
      h('a', { class: 'back', href: '#customer-' + encodeURIComponent(t.truck_id), text: '← Back to my truck' }),
      h('p', { class: 'eyebrow', text: 'Customer portal' }),
      h('h1', { class: 'title' }, 'Request service'),
      h('p', { class: 'lede' }, h('strong', { text: t.truck_id }), t.truck_name ? ' · ' + t.truck_name : '', ' · Farber Service will get back to you to schedule it.'),
      preview ? h('div', { class: 'notice' }, h('strong', { text: 'Customer view' }), h('span', { text: ' Only the truck’s customer can send this form. Staff create tickets from the truck page.' })) : null,
      form);
  };

  // one truck's service requests (truck page and customer page)
  const truckRequestsCard = (reqs, cust) => h('div', { class: 'card scroll' }, reqs.length ? h('table', { class: 'stack work-table' },
    h('thead', null, h('tr', null, ['Ticket', 'Requested', 'Request', 'Urgency', 'Status', 'Scheduled'].map((x) => h('th', { text: x })))),
    h('tbody', null, reqs.map((x) => h('tr', null,
      h('td', { class: 'first nowrap', 'data-label': 'Ticket' }, canOpenTickets() ? ticketLink(x.ticket_no) : '#' + x.ticket_no),
      h('td', { class: 'nowrap', 'data-label': 'Requested' }, h('div', { text: fmtDay(x.created_at) }), !cust && x.requester_name ? h('div', { class: 'note', text: x.requester_name }) : null),
      h('td', { 'data-label': 'Request' }, h('div', { class: 'work-title' }, canOpenTickets() ? h('a', { href: '#ticket-' + x.ticket_no, text: x.title }) : x.title), h('div', { class: 'note', text: [x.category, x.system, x.details].filter(Boolean).join(' · ') })),
      h('td', { 'data-label': 'Urgency' }, h('span', { class: 'pill ' + tagTone(x, URG_TONE[x.urgency]), text: x.urgency })),
      h('td', { 'data-label': 'Status' }, h('span', { class: 'pill ' + (REQ_TONE[x.status] || 'muted'), text: x.status })),
      h('td', { 'data-label': 'Scheduled', class: 'nowrap' }, h('div', { text: x.scheduled_for ? fmtDay(x.scheduled_for) : '—' }), x.assigned_to ? h('div', { class: 'note', text: x.assigned_to }) : null)))))
    : h('p', { class: 'muted', text: cust ? 'You haven’t requested service for this truck yet.' : 'No open tickets for this truck.' }));

  // ---------- service requests (Service users and admins)
  const REQ_STATUS = ['New', 'In progress', 'Scheduled', 'Done', 'Cancelled'];
  const REQ_TONE = { New: 'accent', 'In progress': 'warn', Scheduled: 'ok', Done: 'muted', Cancelled: 'muted' };
  const URG_TONE = { Urgent: 'bad', Normal: 'muted', Low: 'muted' };
  // customers open their own tickets; staff need Service or admin
  const canOpenTickets = () => isCustomer() || canSeeTickets();
  // closed tickets (done or cancelled) show urgency and type in gray
  const tagTone = (k, tone) => (['Done', 'Cancelled'].includes(k.status) ? 'muted' : tone || 'muted');
  const renderRequests = async (r, token) => {
    const reqs = await rpc('web_service_requests');
    if (token !== renderToken) return;
    let tab = 'open';
    const isOpen = (q) => ['New', 'In progress', 'Scheduled'].includes(q.status);
    const n = (k) => reqs.filter((q) => k === 'all' || (k === 'open' ? isOpen(q) : q.status === k)).length;
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search ticket number, truck, customer or request', 'aria-label': 'Search service tickets' });
    const count = h('span', { class: 'note' });
    const tabs = h('div', { class: 'seg tabs-row', role: 'tablist', 'aria-label': 'Filter by status' });
    const tbody = h('tbody');
    const draw = () => {
      tabs.replaceChildren(...[['open', 'Open'], ...REQ_STATUS.map((x) => [x, x]), ['all', 'All']].filter(([k]) => ['open', 'all'].includes(k) || n(k) > 0)
        .map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(tab === k), onclick: () => { tab = k; draw(); } }, `${l} (${n(k)})`)));
      const q = clean(search.value).toLowerCase();
      const rows = reqs.filter((x) => (tab === 'all' || (tab === 'open' ? isOpen(x) : x.status === tab))
        && (!q || ['#' + x.ticket_no, x.truck_id, x.truck_name, x.company, x.requester_name, x.requested_by, x.req_contact_name, x.truck_location, x.title, x.details].some((v) => String(v || '').toLowerCase().includes(q))));
      count.textContent = `${rows.length} ${rows.length === 1 ? 'ticket' : 'tickets'}`;
      tbody.replaceChildren(...(rows.length ? rows.map((x) => h('tr', null,
        h('td', { class: 'first nowrap', 'data-label': 'Ticket' }, ticketLink(x.ticket_no)),
        h('td', { class: 'nowrap', 'data-label': 'Requested' }, h('div', { text: fmtDay(x.created_at) }), h('div', { class: 'note', text: ago(Math.round((Date.now() - new Date(x.created_at).getTime()) / 60000)) })),
        h('td', { 'data-label': 'Truck' }, h('a', { href: '#truck-' + encodeURIComponent(x.truck_id) }, h('strong', { text: x.truck_id })), x.truck_name ? h('div', { class: 'note', text: x.truck_name }) : null),
        h('td', { 'data-label': 'Customer' }, h('div', { text: x.requester_name || (x.source === 'Farber' ? 'Farber' : x.requested_by) || '—' }), x.company ? h('div', { class: 'note', text: x.company }) : null,
          x.req_contact_name && x.req_contact_name !== x.requester_name ? h('div', { class: 'note', text: 'Contact: ' + [x.req_contact_name, x.req_contact_phone].filter(Boolean).join(' · ') }) : null),
        h('td', { 'data-label': 'Request' }, h('div', { class: 'work-title' }, h('a', { href: '#ticket-' + x.ticket_no, text: x.title })), h('div', { class: 'note', text: [x.category, x.system, x.details].filter(Boolean).join(' · ') })),
        h('td', { 'data-label': 'Urgency' }, h('span', { class: 'pill ' + tagTone(x, URG_TONE[x.urgency]), text: x.urgency })),
        h('td', { 'data-label': 'Status' }, h('span', { class: 'pill ' + (REQ_TONE[x.status] || 'muted'), text: x.status })),
        h('td', { 'data-label': 'Scheduled', class: 'nowrap' }, h('div', { text: x.scheduled_for ? fmtDay(x.scheduled_for) : '—' }), x.assigned_to ? h('div', { class: 'note', text: x.assigned_to }) : null)))
        : [h('tr', null, h('td', { colspan: '8', class: 'muted', text: 'No tickets here.' }))]));
    };
    search.addEventListener('input', draw);
    draw();
    const urgent = reqs.filter((x) => isOpen(x) && x.urgency === 'Urgent').length;
    app.replaceChildren(
      h('p', { class: 'eyebrow', text: 'Service' }),
      h('h1', { class: 'title', text: 'Service tickets' }),
      h('p', { class: 'lede', text: 'Every job has a ticket: customer requests, scheduled work and finished maintenance. Open tickets come first, most urgent at the top. Closed tickets from the last 90 days are here too; older ones are in each truck’s Maintenance history.' }),
      isServiceView() ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#newticket', text: 'New ticket' })) : null,
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('h3', { text: 'New' }), h('span', { class: 'big' + (n('New') ? ' warn' : ''), text: num(n('New')) }), h('span', { class: 'sub', text: 'Waiting for Farber' })),
        h('div', { class: 'tile' }, h('h3', { text: 'Urgent and open' }), h('span', { class: 'big' + (urgent ? ' bad' : ''), text: num(urgent) }), h('span', { class: 'sub', text: 'Marked urgent by the customer' })),
        h('div', { class: 'tile' }, h('h3', { text: 'In progress' }), h('span', { class: 'big', text: num(n('In progress')) }), h('span', { class: 'sub', text: 'Being worked on' })),
        h('div', { class: 'tile' }, h('h3', { text: 'Scheduled' }), h('span', { class: 'big', text: num(n('Scheduled')) }), h('span', { class: 'sub', text: 'Booked with a date' }))),
      tabs,
      h('div', { class: 'toolbar' }, search, count),
      h('div', { class: 'card scroll' }, h('table', { class: 'stack work-table' },
        h('thead', null, h('tr', null, ['Ticket', 'Requested', 'Truck', 'Customer', 'Request', 'Urgency', 'Status', 'Scheduled'].map((x) => h('th', { text: x })))), tbody)));
  };

  // ---------- customer portal: the customer's own truck, current information only
  const renderCustomer = async (r, token) => {
    // staff preview of the customer page: admins and Sales
    if (!isCustomer() && !isAdmin() && !isSalesView()) { location.replace('#truck-' + encodeURIComponent(r.id)); return; }
    let t, maint, mine = [], reqs = [];
    try {
      [t, maint, mine, reqs] = await Promise.all([
        rpc('web_customer_truck', { p_truck: r.id }),
        rpc('web_customer_maint', { p_truck: r.id }),
        isCustomer() ? rpc('web_my_trucks') : Promise.resolve([]),
        rpc('web_truck_requests', { p_truck: r.id })]);
    } catch (err) {
      if (!/Not allowed/i.test(err.message || '')) throw err;
      app.replaceChildren(h('div', { class: 'empty', text: 'This truck isn’t linked to your account.' },
        isCustomer() ? h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn ghost', href: '#mytrucks', text: 'My trucks' })) : null));
      return;
    }
    if (token !== renderToken) return;
    if (!t) { app.replaceChildren(h('div', { class: 'empty', text: `There is no truck ${r.id}.` })); return; }
    const { nowPanels } = nowPanelsFor(t, maint, true);
    // more than one truck: a dropdown to switch
    let picker = null;
    if (mine.length > 1) {
      const sel = h('select', { id: 'cust-truck', 'aria-label': 'Choose a truck' },
        mine.map((x) => h('option', { value: x.truck_id, text: x.truck_id + (x.truck_name ? ' · ' + x.truck_name : '') })));
      sel.value = t.truck_id;
      sel.addEventListener('change', () => { location.hash = '#customer-' + encodeURIComponent(sel.value); });
      picker = h('div', { class: 'truck-switch' }, h('label', { for: 'cust-truck', text: `Your trucks (${mine.length})` }), sel);
    }
    app.replaceChildren(...[
      isCustomer() ? null : h('a', { class: 'back', href: '#truck-' + encodeURIComponent(t.truck_id), text: '← Back to the truck page' }),
      isCustomer() ? null : h('div', { class: 'notice' }, h('strong', { text: 'Customer view' }), h('span', { text: ' This is the page the truck’s customer sees. Their address and contact, the Farber team, IP address and firmware are hidden.' })),
      picker,
      h('h1', { class: 'title' }, t.truck_id, t.truck_name ? h('span', { class: 'sub', text: ' · ' + t.truck_name }) : null),
      h('div', { class: 'meta' }, statusPill(t.status), healthPill(t.health), t.warnings ? h('span', { class: 'why', text: t.warnings }) : null,
        h('span', { text: 'Last report ' + ago(t.minutes_since_seen) })),
      h('div', { class: 'section-head' }, h('h2', { text: 'Truck details' })),
      h('div', { class: 'panels' }, panel('Build and delivery', kv('Build date', t.build_date), kv('Delivery date', t.delivery_date), kv('In service', t.in_service))),
      h('div', { class: 'section-head' }, h('h2', { text: 'Service requests' }), h('p', { class: 'note', text: 'Open requests first' })),
      isSalesView() ? null : h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#request-' + encodeURIComponent(t.truck_id), text: 'Request service' })),
      truckRequestsCard(reqs, true),
      h('div', { class: 'section-head' }, h('h2', { text: 'Right now' }), h('p', { class: 'note', text: 'Latest report from your truck.' })),
      h('div', { class: 'panels' }, nowPanels),
    ].filter(Boolean));
  };
  // "My trucks" opens the first truck; the dropdown on that page switches between them
  const renderMyTrucks = async (r, token) => {
    const rows = await rpc('web_my_trucks');
    if (token !== renderToken) return;
    if (rows.length) { location.replace('#customer-' + encodeURIComponent(rows[0].truck_id)); return; }
    app.replaceChildren(h('h1', { class: 'title', text: 'My trucks' }),
      h('div', { class: 'empty', text: 'No trucks are linked to your account yet. Ask Farber to add them.' }));
  };

  // ---------- users (admin)
  // A searchable checklist of trucks (for customer accounts)
  const truckPicker = (allTrucks, selected) => {
    const chosen = new Set(selected || []);
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Find a truck', 'aria-label': 'Find a truck' });
    const box = h('div', { class: 'pick-list' });
    const count = h('span', { class: 'note' });
    const draw = () => {
      const q = clean(search.value).toLowerCase();
      box.replaceChildren(...allTrucks.filter((t) => !q || (t.truck_id + ' ' + (t.truck_name || '')).toLowerCase().includes(q)).map((t) => {
        const cb = h('input', { type: 'checkbox', value: t.truck_id });
        cb.checked = chosen.has(t.truck_id);
        cb.addEventListener('change', () => { if (cb.checked) chosen.add(t.truck_id); else chosen.delete(t.truck_id); count.textContent = `${chosen.size} selected`; });
        return h('label', { class: 'pick' }, cb, h('span', { text: t.truck_id + (t.truck_name ? ' · ' + t.truck_name : '') }));
      }));
      count.textContent = `${chosen.size} selected`;
    };
    search.addEventListener('input', draw);
    draw();
    return { el: h('div', { class: 'picker' }, h('div', { class: 'toolbar' }, search, count), box), value: () => [...chosen] };
  };

  const STAFF_TYPES = Object.fromEntries(Object.entries(TYPES).filter(([k]) => k !== 'customer'));

  const renderUsers = async (r, token) => {
    const [users, fleet] = await Promise.all([rpc('web_users'), rpc('web_fleet')]);
    if (token !== renderToken) return;
    const allTrucks = fleet.map((t) => ({ truck_id: t.truck_id, truck_name: t.truck_name }));
    const truckName = (id) => (allTrucks.find((t) => t.truck_id === id) || {}).truck_name || '';
    let allUsers = users;
    let section = (() => { try { return sessionStorage.getItem('ff-users-section') || 'team'; } catch (e) { return 'team'; } })();
    let teamTab = 'all';
    let custQuery = '';

    // ---- invite code box (shared)
    const codeBox = h('div', { class: 'notice good', hidden: true });
    const copyText = async (text, el, statusEl) => {
      try { await navigator.clipboard.writeText(text); statusEl.textContent = 'Copied'; }
      catch (e) { const rg = document.createRange(); rg.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); statusEl.textContent = 'Selected: press Copy'; }
      setTimeout(() => { statusEl.textContent = ''; }, 2500);
    };
    const showCode = (res, what) => {
      const site = location.origin + location.pathname;
      const msg = [
        'You’ve been added to Farber Fleet.',
        '',
        'Website:',
        site,
        '',
        'Email:',
        res.email,
        '',
        'Invite code:',
        res.code,
        '',
        'Open the website, press "First time here", enter your email, choose a password and type the invite code.',
        `The code works once, until ${fmtDay(res.expires)}.`,
      ].join('\n');
      const row = (label, value, mono) => {
        const val = h('span', { class: 'copy-val' + (mono ? ' mono' : ''), text: value });
        const st = h('span', { class: 'status ok' });
        return h('div', { class: 'copy-row' }, h('span', { class: 'copy-label', text: label }), val,
          h('button', { class: 'btn small ghost', type: 'button', text: 'Copy', onclick: () => copyText(value, val, st) }), st);
      };
      const pre = h('pre', { class: 'code', text: msg });
      const allStatus = h('span', { class: 'status ok' });
      codeBox.hidden = false;
      codeBox.replaceChildren(
        h('strong', { text: `${what} ${res.email}` }),
        h('p', { class: 'note', text: 'Send these to the person (text, email or in person). The code is shown only now and works once.' }),
        h('div', { class: 'copy-rows' }, row('Website', site), row('Email', res.email), row('Invite code', res.code, true)),
        h('details', { class: 'copy-msg' }, h('summary', { text: 'Whole message' }), pre),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Copy whole message', onclick: () => copyText(msg, pre, allStatus) }), allStatus));
      window.scrollTo(0, 0);
    };

    const listStatus = h('p', { class: 'status', 'aria-live': 'polite' });
    const say = (cls, text) => { listStatus.className = 'status ' + cls; listStatus.textContent = text; };
    const refreshList = async () => { allUsers = await rpc('web_users'); draw(); };

    // shared row pieces
    const statusCell = (u) => h('td', { 'data-label': 'Status', class: u.status === 'Active' ? 'ok' : 'warn',
      text: u.status === 'Active' ? 'Active' + (u.last_sign_in_at ? ' · last in ' + fmtDay(u.last_sign_in_at) : '') : u.status === 'Invited' ? `Invited · code works until ${fmtDay(u.invite_expires)}` : 'Code expired' });
    const personCell = (u) => h('td', { class: 'first', 'data-label': 'Person' }, h('div', { text: u.name || u.email }), u.name ? h('div', { class: 'note', text: u.email }) : null);
    const actionsCell = (u) => {
      const armed = {};
      const twoStep = (key, label, warn, fn) => {
        const b = h('button', { class: 'btn ' + (key === 'remove' ? 'danger' : 'ghost'), type: 'button', text: label });
        b.addEventListener('click', async () => {
          if (!armed[key]) { armed[key] = true; b.textContent = label + ' — press again'; say('bad', warn); return; }
          b.disabled = true;
          try { await fn(); } catch (err) { say('bad', friendly(err)); b.disabled = false; }
        });
        return b;
      };
      return h('td', { 'data-label': 'Actions' }, u.is_me ? h('span', { class: 'note', text: 'This is you' }) : h('div', { class: 'actions' },
        twoStep('reset', u.status === 'Active' ? 'Reset sign-in' : 'New code',
          u.status === 'Active' ? `Resetting ends ${u.email}’s current sign-in and makes a new invite code. They set a new password with it.` : `This replaces ${u.email}’s old invite code.`,
          async () => { const res = await rpc('web_user_reset', { p_email: u.email }); await refreshList(); showCode(res, 'New code for'); }),
        twoStep('remove', 'Remove', `${u.email} will lose access right away.`,
          async () => { await rpc('web_user_remove', { p_email: u.email }); await refreshList(); say('ok', `${u.email} removed.`); })));
    };
    const setTrucks = async (u, trucks, msg) => {
      say('busy', 'Saving…');
      try { await rpc('web_user_set_type', { p_email: u.email, p_type: 'customer', p_trucks: trucks }); await refreshList(); say('ok', msg); }
      catch (err) { say('bad', friendly(err)); }
    };

    // ---- Farber team
    const teamPanel = () => {
      const em = field('Email', { type: 'email', autocomplete: 'off' });
      const nm = field('Name (optional)', { autocomplete: 'off', maxlength: '80' });
      const typeSel = h('select', { id: 'new-type' }, h('option', { value: '', text: 'Choose…' }),
        Object.entries(STAFF_TYPES).map(([v, l]) => h('option', { value: v, text: l })));
      const roleSel = h('select', { id: 'new-role' }, h('option', { value: 'viewer', text: 'Viewer (can look)' }), h('option', { value: 'admin', text: 'Admin (can also edit and manage users)' }));
      const st = h('span', { class: 'status' });
      const btn = h('button', { class: 'btn', type: 'submit', text: 'Add team member' });
      const form = h('form', { class: 'card form', novalidate: true },
        h('h2', { text: 'Add a Farber team member' }),
        h('div', { class: 'grid' }, em.wrap, nm.wrap,
          h('div', { class: 'field' }, h('label', { for: 'new-type', text: 'User type' }), typeSel),
          h('div', { class: 'field' }, h('label', { for: 'new-role', text: 'Access' }), roleSel)),
        h('div', { class: 'actions' }, btn, st));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = clean(em.input.value).toLowerCase();
        if (!EMAIL_OK.test(email)) { st.className = 'status bad'; st.textContent = 'Enter an email address.'; return; }
        if (!typeSel.value) { st.className = 'status bad'; st.textContent = 'Choose a user type.'; return; }
        btn.disabled = true; st.className = 'status busy'; st.textContent = 'Adding…';
        try {
          const res = await rpc('web_user_add', { p_email: email, p_name: clean(nm.input.value), p_role: roleSel.value, p_type: typeSel.value, p_trucks: [] });
          await refreshList(); showCode(res, 'Added');
        } catch (err) { st.className = 'status bad'; st.textContent = friendly(err); btn.disabled = false; }
      });

      const team = allUsers.filter((u) => u.user_type !== 'customer');
      const n = (k) => team.filter((u) => k === 'all' || (k === 'none' ? !u.user_type : u.user_type === k)).length;
      const tabs = h('div', { class: 'seg tabs-row', role: 'tablist', 'aria-label': 'Filter by user type' },
        [['all', 'All'], ...Object.entries(STAFF_TYPES), ['none', 'Not set']].filter(([k]) => k !== 'none' || n('none') > 0)
          .map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(teamTab === k), onclick: () => { teamTab = k; draw(); } }, `${l} (${n(k)})`)));
      const rows = team.filter((u) => teamTab === 'all' || (teamTab === 'none' ? !u.user_type : u.user_type === teamTab));
      const tbody = h('tbody', null, rows.length ? rows.map((u) => {
        const typeSel = h('select', { 'aria-label': 'User type for ' + u.email },
          u.user_type ? null : h('option', { value: '', text: 'Not set' }),
          Object.entries(STAFF_TYPES).map(([v, l]) => h('option', { value: v, text: l })));
        typeSel.value = u.user_type || '';
        typeSel.addEventListener('change', async () => {
          if (!typeSel.value) return;
          typeSel.disabled = true; say('busy', 'Saving…');
          try { await rpc('web_user_set_type', { p_email: u.email, p_type: typeSel.value, p_trucks: [] }); await refreshList(); say('ok', `${u.email} is now ${TYPES[typeSel.value]}.`); }
          catch (err) { typeSel.value = u.user_type || ''; typeSel.disabled = false; say('bad', friendly(err)); }
        });
        const roleSel = h('select', { 'aria-label': 'Access for ' + u.email }, h('option', { value: 'viewer', text: 'Viewer' }), h('option', { value: 'admin', text: 'Admin' }));
        roleSel.value = u.role;
        roleSel.addEventListener('change', async () => {
          roleSel.disabled = true; say('busy', 'Saving…');
          try { await rpc('web_user_set_role', { p_email: u.email, p_role: roleSel.value }); u.role = roleSel.value; say('ok', `${u.email} is now ${roleSel.value === 'admin' ? 'an admin' : 'a viewer'}.`); }
          catch (err) { roleSel.value = u.role; say('bad', friendly(err)); }
          roleSel.disabled = false;
        });
        return h('tr', null, personCell(u),
          h('td', { 'data-label': 'Type' }, typeSel),
          h('td', { 'data-label': 'Access' }, u.is_me ? h('span', { text: u.role === 'admin' ? 'Admin' : 'Viewer' }) : roleSel),
          statusCell(u), actionsCell(u));
      }) : h('tr', null, h('td', { colspan: '5', class: 'muted', text: 'Nobody in this group yet.' })));
      return [form, tabs, h('div', { class: 'card scroll' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['Person', 'Type', 'Access', 'Status', ''].map((x) => h('th', { text: x })))), tbody), listStatus)];
    };

    // ---- Customers
    const customerPanel = () => {
      const em = field('Email', { type: 'email', autocomplete: 'off' });
      const nm = field('Name (optional)', { autocomplete: 'off', maxlength: '80' });
      const picker = truckPicker(allTrucks, []);
      const st = h('span', { class: 'status' });
      const btn = h('button', { class: 'btn', type: 'submit', text: 'Add customer' });
      const form = h('form', { class: 'card form', novalidate: true },
        h('h2', { text: 'Add a customer' }),
        h('div', { class: 'grid' }, em.wrap, nm.wrap,
          h('div', { class: 'field wide' }, h('span', { class: 'field-label', text: 'Their truck (at least one)' }), picker.el)),
        h('div', { class: 'actions' }, btn, st));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = clean(em.input.value).toLowerCase();
        if (!EMAIL_OK.test(email)) { st.className = 'status bad'; st.textContent = 'Enter an email address.'; return; }
        if (!picker.value().length) { st.className = 'status bad'; st.textContent = 'Pick the customer’s truck.'; return; }
        btn.disabled = true; st.className = 'status busy'; st.textContent = 'Adding…';
        try {
          const res = await rpc('web_user_add', { p_email: email, p_name: clean(nm.input.value), p_role: 'viewer', p_type: 'customer', p_trucks: picker.value() });
          await refreshList(); showCode(res, 'Added');
        } catch (err) { st.className = 'status bad'; st.textContent = friendly(err); btn.disabled = false; }
      });

      const custs = allUsers.filter((u) => u.user_type === 'customer');
      const search = h('input', { id: 'cust-search', class: 'search', type: 'search', placeholder: 'Find a customer, email or truck', 'aria-label': 'Find a customer', value: custQuery });
      const tbody = h('tbody');
      const drawRows = () => {
        const q = custQuery.toLowerCase();
        const rows = custs.filter((u) => !q || [u.name, u.email, ...(u.customer_trucks || []), ...(u.customer_trucks || []).map(truckName)].join(' ').toLowerCase().includes(q));
        tbody.replaceChildren(...(rows.length ? rows.map((u) => {
          const mine = u.customer_trucks || [];
          const cell = h('div', { class: 'truck-cell' });
          const drawCell = () => {
            cell.replaceChildren(
              h('div', { class: 'chips' }, mine.map((id) => h('span', { class: 'chip' },
                h('a', { href: '#customer-' + encodeURIComponent(id), title: 'Open the customer page' }, h('strong', { text: id }), truckName(id) ? ' · ' + truckName(id) : ''),
                mine.length > 1 ? h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove truck ${id} from ${u.email}`, title: 'Remove this truck', text: '×', onclick: () =>
                  setTrucks(u, mine.filter((x) => x !== id), `Truck ${id} removed from ${u.name || u.email}.`) }) : null))),
              h('button', { class: 'btn small', type: 'button', text: '+ Add a truck', onclick: openAdd }));
          };
          const openAdd = () => {
            const pk = truckPicker(allTrucks.filter((t) => !mine.includes(t.truck_id)), []);
            cell.replaceChildren(
              h('div', { class: 'note', text: `Add trucks for ${u.name || u.email}:` }), pk.el,
              h('div', { class: 'actions' },
                h('button', { class: 'btn small', type: 'button', text: 'Add', onclick: () => {
                  const add = pk.value();
                  if (!add.length) { say('bad', 'Tick the truck they bought.'); return; }
                  setTrucks(u, [...mine, ...add].sort(), `Added ${add.join(', ')} for ${u.name || u.email}.`);
                } }),
                h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: drawCell })));
          };
          drawCell();
          return h('tr', null, personCell(u), h('td', { 'data-label': 'Trucks' }, cell), statusCell(u), actionsCell(u));
        }) : [h('tr', null, h('td', { colspan: '4', class: 'muted', text: custs.length ? 'No customer matches that.' : 'No customers yet.' }))]));
      };
      search.addEventListener('input', () => { custQuery = clean(search.value); drawRows(); });
      drawRows();
      const unowned = allTrucks.filter((t) => !custs.some((u) => (u.customer_trucks || []).includes(t.truck_id)));
      return [form,
        h('div', { class: 'toolbar cust-tools' }, search, h('span', { class: 'note', text: `${custs.length} ${custs.length === 1 ? 'customer' : 'customers'} · ` + (unowned.length ? `${unowned.length} ${unowned.length === 1 ? 'truck' : 'trucks'} with no customer: ${unowned.map((t) => t.truck_id).join(', ')}` : 'every truck has a customer') })),
        h('div', { class: 'card scroll' }, h('table', { class: 'stack' },
          h('thead', null, h('tr', null, ['Customer', 'Trucks', 'Status', ''].map((x) => h('th', { text: x })))), tbody), listStatus)];
    };

    const draw = () => {
      const nTeam = allUsers.filter((u) => u.user_type !== 'customer').length;
      const nCust = allUsers.length - nTeam;
      const switcher = h('div', { class: 'seg section-switch', role: 'tablist', 'aria-label': 'Which list' },
        [['team', `Farber team (${nTeam})`], ['customers', `Customers (${nCust})`]].map(([k, l]) =>
          h('button', { type: 'button', role: 'tab', 'aria-pressed': String(section === k), text: l, onclick: () => {
            section = k; try { sessionStorage.setItem('ff-users-section', k); } catch (e) {}
            codeBox.hidden = true; say('', ''); draw();
          } })));
      app.replaceChildren(
        h('h1', { class: 'title', text: 'Users' }),
        h('p', { class: 'lede', text: section === 'team'
          ? 'Farber staff (Sales, Service, Engineering) see the whole fleet. Viewers look; admins can also edit and add trucks and manage users. Adding someone gives you a one-time invite code to pass on.'
          : 'Customers only see the customer page for their own trucks. When a customer buys another truck, press + Add a truck on their row.' }),
        switcher, codeBox,
        ...(section === 'team' ? teamPanel() : customerPanel()));
    };
    draw();
  };

  route();
})();
