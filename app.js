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
  const TEXT_KEYS = ['name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
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
  const statusPill = (s) => h('span', { class: 'pill ' + (s === 'Online' ? 'ok' : s === 'Offline' ? 'bad' : 'muted'), text: s });
  const healthPill = (s) => h('span', { class: 'pill ' + (s === 'Good' ? 'ok' : 'warn'), text: s });
  const TYPES = { sales: 'Sales', service: 'Service', engineering: 'Engineering', customer: 'Customer' };
  // Admins can preview the site as another (staff) user type; customers have their own pages.
  let viewAs = null;
  try { viewAs = sessionStorage.getItem('ff-view-as'); } catch (e) { viewAs = null; }
  const realAdmin = () => me && me.role === 'admin';
  const isAdmin = () => realAdmin() && !viewAs;
  const isCustomer = () => me && me.user_type === 'customer';
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
    $('who').textContent = !signedIn ? '' : viewAs ? `${me.name || me.email} · viewing as ${TYPES[viewAs]}`
      : (me.name || me.email) + (me.user_type ? ' · ' + typeLabel(me.user_type) : '') + (isAdmin() ? ' · admin' : '');
    document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !isAdmin(); });
    document.querySelectorAll('.staff-only').forEach((el) => { el.hidden = !signedIn || isCustomer(); });
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
    if (['trucks', 'offline', 'shocks', 'warnings', 'edit', 'new', 'users', 'account', 'mytrucks'].includes(raw)) return { page: raw, id: null };
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
    if (isCustomer() && !['customer', 'account', 'mytrucks'].includes(r.page)) r = { page: 'mytrucks', id: null };
    markMenu(r.page === 'truck' ? 'trucks' : r.page);
    window.scrollTo(0, 0);
    const adminPages = ['edit', 'new', 'users'];
    if (adminPages.includes(r.page) && !isAdmin()) {
      app.replaceChildren(h('div', { class: 'empty', text: 'Only Farber Fleet admins can open this page.' }));
      return;
    }
    const pages = { trucks: renderFleet, truck: renderTruck, offline: renderOffline, shocks: renderShocks, warnings: renderWarnings,
      edit: r.id ? renderEditor : renderEditList, new: renderEditor, users: renderUsers, account: renderAccount,
      customer: renderCustomer, mytrucks: renderMyTrucks };
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

  const renderSignIn = () => {
    let mode = 'signin';
    const status = h('p', { class: 'status', 'aria-live': 'polite' });
    const email = field('Email', { type: 'email', autocomplete: 'email', required: true });
    const pass = field('Password', { type: 'password', autocomplete: 'current-password', required: true, minlength: '8' });
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
      h('div', { class: 'tabs', role: 'tablist' }, tabIn, tabNew), email.wrap, pass.wrap, code.wrap, submit, status, help);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const em = clean(email.input.value).toLowerCase();
      const pw = pass.input.value;
      if (!EMAIL_OK.test(em)) { status.className = 'status bad'; status.textContent = 'Enter your email address.'; return; }
      if (pw.length < 8) { status.className = 'status bad'; status.textContent = 'Passwords are at least 8 characters.'; return; }
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
    const p1 = field('New password (8 or more characters)', { type: 'password', autocomplete: 'new-password' });
    const p2 = field('New password again', { type: 'password', autocomplete: 'new-password' });
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
      p1.input.value = ''; p2.input.value = '';
      status.className = 'status ok'; status.textContent = 'Password changed.';
    });
    app.replaceChildren(
      h('h1', { class: 'title', text: 'My account' }),
      h('div', { class: 'card' },
        h('div', { class: 'kv' }, h('span', { text: 'Email' }), h('b', { text: me.email })),
        h('div', { class: 'kv' }, h('span', { text: 'Name' }), h('b', { text: me.name || '—' })),
        h('div', { class: 'kv' }, h('span', { text: 'Access' }), h('b', { text: me.role === 'admin' ? 'Admin (view, edit, add trucks, manage users)' : 'Viewer' }))),
      form);
  };

  // ---------- fleet list
  const renderFleet = async (r, token) => {
    const [kpis, fleet] = await Promise.all([rpc('web_kpis'), rpc('web_fleet')]);
    if (token !== renderToken) return;
    const k = kpis[0] || {};
    const warnings = fleet.filter((t) => t.health === 'Warning').length;
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
        h('a', { class: 'tile', href: '#offline' }, h('h3', { text: 'Trucks offline' }), h('span', { class: 'big' + (k.trucks_offline ? ' bad' : ''), text: num(k.trucks_offline) }), h('span', { class: 'sub', text: 'No report for 10 minutes · open list →' })),
        h('a', { class: 'tile', href: '#shocks' }, h('h3', { text: 'Shocks this week' }), h('span', { class: 'big', text: num(k.shocks_7d) }), h('span', { class: 'sub', text: `${num(k.shocks_24h)} in the last 24 hours · open list →` })),
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

  const routeMap = (rows, width) => {
    const p = rows.filter((r) => present(r.lat) && present(r.lon));
    if (p.length < 2) return null;
    const W = Math.max(240, Math.round(width || 600)), H = Math.round(Math.min(340, Math.max(200, W * 0.45))), M = 16;
    let a0 = Math.min(...p.map((r) => r.lat)), a1 = Math.max(...p.map((r) => r.lat));
    let o0 = Math.min(...p.map((r) => r.lon)), o1 = Math.max(...p.map((r) => r.lon));
    const k = Math.cos(((a0 + a1) / 2) * Math.PI / 180);
    let w = Math.max((o1 - o0) * k, 0.01), hgt = Math.max(a1 - a0, 0.01);
    const s = Math.min((W - 2 * M) / w, (H - 2 * M) / hgt);
    const cx = (o0 + o1) / 2, cy = (a0 + a1) / 2;
    const X = (lon) => W / 2 + (lon - cx) * k * s;
    const Y = (lat) => H / 2 - (lat - cy) * s;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Route for the selected time window');
    const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [kk, v] of Object.entries(attrs)) e.setAttribute(kk, v); svg.append(e); return e; };
    add('rect', { x: 0, y: 0, width: W, height: H, fill: 'var(--bg)', rx: 8 });
    add('polyline', { points: p.map((r) => X(r.lon).toFixed(1) + ',' + Y(r.lat).toFixed(1)).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' });
    add('circle', { cx: X(p[0].lon), cy: Y(p[0].lat), r: 5, fill: 'var(--muted)' });
    add('circle', { cx: X(p[p.length - 1].lon), cy: Y(p[p.length - 1].lat), r: 7, fill: 'var(--s1)', stroke: 'var(--panel)', 'stroke-width': 2 });
    return svg;
  };

  // shared by the staff truck page and the customer page (cust = hide IP and firmware)
  const nowPanelsFor = (t, maint, cust) => {
    const needs = (k) => t['has_' + k];
    const nowPanels = [
      needs('temps') && panel('Temperatures',
        [1, 2, 3, 4, 5, 6].map((i) => kv(t['temp' + i + '_label'] || 'Temp ' + i, num(t['temp' + i + '_f'], 1), '°F'))),
      panel('Truck',
        kv('Engine', t.engine), kv('Speed', num(t.speed_mph), ' mph'), kv('RPM', num(t.rpm)), kv('Mileage', num(t.odometer_mi), ' mi'), kv('Fuel', num(t.fuel_pct), '%'),
        needs('oil') && kv('Oil pressure', num(t.oil_psi), ' psi'), kv('Coolant', num(t.coolant_f), '°F'),
        kv('Fault codes', present(t.dtc_count) ? t.dtc_count : null, null, t.dtc_count > 0 ? 'bad' : null)),
      panel('Batteries',
        kv('Chassis', num(t.chassis_v, 1), ' V', tone('chassis_v', t.chassis_v)),
        needs('aux') && kv('Aux', num(t.aux_v, 1), ' V', tone('aux_v', t.aux_v)),
        needs('aux') && kv('Aux current', num(t.aux_a, 1), ' A'),
        kv('Tracker battery', num(t.board_v, 2), ' V', tone('board_v', t.board_v))),
      needs('generator') && panel('Generator',
        kv('Generator', t.generator, null, t.generator === 'Error' ? 'bad' : null), kv('Error code', t.gen_error_code),
        kv('Hour meter', num(t.gen_hours, 1), ' h'), kv('Generator battery', num(t.gen_battery_v, 1), ' V')),
      needs('shore') && panel('Shore power', kv('Shore power', t.shore), kv('Draw', num(t.shore_amps, 1), ' A')),
      needs('solar') && panel('Solar', kv('Output', num(t.solar_w), ' W')),
      needs('plumbing') && panel('Water', kv('Fresh', num(t.fresh_pct), '%'), kv('Gray', num(t.gray_pct), '%'), kv('Black', num(t.black_pct), '%'), kv('Pump', t.pump)),
      needs('jacks') && panel('Jacks', kv('Jacks', t.jacks, null, t.jacks === 'Error' ? 'bad' : null), kv('Error code', t.jacks_error_code)),
      panel(cust ? 'Location' : 'Location and network',
        h('div', { class: 'kv' }, h('span', { text: 'Near' }), present(t.lat)
          ? h('a', { href: mapUrl(t.lat, t.lon), target: '_blank', rel: 'noopener', text: [t.near_city, t.near_state].filter(Boolean).join(', ') || 'Map' })
          : h('b', { text: '—' })),
        cust ? kv('Status', t.status, null, t.status === 'Online' ? 'ok' : 'bad') : kv('Connection', t.network),
        !cust && t.network === 'Wi-Fi' ? kv('Wi-Fi network', t.wifi_ssid) : null,
        !cust && t.network === 'Cellular' ? kv('Last on Wi-Fi', t.last_wifi_at ? ago(Math.round((Date.now() - new Date(t.last_wifi_at).getTime()) / 60000)) : 'Never') : null,
        cust ? null : kv('IP address', t.ip_addr),
        cust ? null : kv('Firmware', t.fw)),
    ].filter(Boolean);

    const hrsFmt = (v, d) => num(v, d === undefined ? (Number.isInteger(Number(v)) ? 0 : 1) : d) + ' h';
    const maintRows = maint.map((m) => {
      const byHours = present(m.interval_hours);
      const every = [byHours ? `${num(m.interval_hours)} hours` : '', present(m.interval_days) ? (m.interval_days % 365 === 0 ? `${m.interval_days / 365 * 12} months` : m.interval_days >= 28 ? `${Math.round(m.interval_days / 30.4)} months` : `${m.interval_days} days`) : ''].filter(Boolean).join(' or ');
      let st, cls;
      if (m.status === 'Overdue') { cls = 'bad'; st = byHours && present(m.hours_left) && m.hours_left <= 0 ? `Overdue by ${hrsFmt(-m.hours_left)}` : `Overdue by ${m.days_overdue} day${m.days_overdue === 1 ? '' : 's'}`; }
      else if (m.status === 'OK') { cls = 'ok'; st = byHours && present(m.hours_left) ? `OK, ${hrsFmt(m.hours_left)} left` : present(m.days_overdue) ? `OK, due in ${-m.days_overdue} days` : 'OK'; }
      else { cls = 'warn'; st = m.status === 'No hour reading' ? 'No hour meter reading' : 'No record'; }
      return h('tr', null,
        h('td', { class: 'first', 'data-label': 'Item', text: m.name }),
        h('td', { 'data-label': 'Last done', text: m.last_done ? fmtDay(m.last_done) + (byHours && present(m.last_hours) ? ` at ${hrsFmt(m.last_hours)}` : '') : 'Never' }),
        h('td', { 'data-label': 'Due every', text: every }),
        h('td', { 'data-label': 'Next due', text: [byHours && present(m.next_due_hours) ? `at ${hrsFmt(m.next_due_hours)}` : '', m.next_due ? fmtDay(m.next_due) : ''].filter(Boolean).join(' or ') || '—' }),
        h('td', { 'data-label': 'Status', class: cls, text: st }));
    });
    return { nowPanels, maintRows };
  };
  const maintTable = (maintRows) => h('div', { class: 'card scroll' }, maintRows.length ? h('table', { class: 'stack' },
    h('thead', null, h('tr', null, ['Item', 'Last done', 'Due every', 'Next due', 'Status'].map((x) => h('th', { text: x })))),
    h('tbody', null, maintRows)) : h('p', { class: 'muted', text: 'No maintenance items.' }));

  const renderTruck = async (r, token) => {
    const id = r.id;
    const [trows, maint, events] = await Promise.all([rpc('web_truck', { p_truck: id }), rpc('web_truck_maint', { p_truck: id }), rpc('web_truck_events', { p_truck: id })]);
    if (token !== renderToken) return;
    const t = trows[0];
    if (!t) { app.replaceChildren(h('a', { class: 'back', href: '#trucks', text: '← All trucks' }), h('div', { class: 'empty', text: `There is no truck ${id}.` })); return; }

    const { nowPanels, maintRows } = nowPanelsFor(t, maint, false);

    const histBox = h('div', { class: 'charts' }, h('p', { class: 'loading', text: 'Loading history…' }));
    const routeBox = h('div', { class: 'card' });
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
        const defs = [
          ['Speed', [{ key: 'speed_mph', label: 'Speed' }], ' mph', 0],
          ['Temperatures 1–3', [1, 2, 3].map((i) => ({ key: 'temp' + i + '_f', label: t['temp' + i + '_label'] || 'Temp ' + i })), '°F', 1],
          ['Temperatures 4–6', [4, 5, 6].map((i) => ({ key: 'temp' + i + '_f', label: t['temp' + i + '_label'] || 'Temp ' + i })), '°F', 1],
          ['Batteries', [{ key: 'chassis_v', label: 'Chassis' }, { key: 'aux_v', label: 'Aux' }], ' V', 2],
          ['Fuel', [{ key: 'fuel_pct', label: 'Fuel' }], '%', 0],
          ['Water tanks', [{ key: 'fresh_pct', label: 'Fresh' }, { key: 'gray_pct', label: 'Gray' }, { key: 'black_pct', label: 'Black' }], '%', 0],
          ['Solar', [{ key: 'solar_w', label: 'Solar' }], ' W', 0],
          ['Shore power draw', [{ key: 'shore_amps', label: 'Shore' }], ' A', 1],
          ['Generator battery', [{ key: 'gen_battery_v', label: 'Generator battery' }], ' V', 2],
        ];
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
        const m = routeMap(rows, (routeBox.clientWidth || 600) - 34);
        const last = [...rows].reverse().find((x) => present(x.lat));
        routeBox.replaceChildren(h('h3', { text: 'Route' }),
          m ? h('p', { class: 'note', text: 'Gray dot: start of the window. Colored dot: latest position.' }) : h('p', { class: 'note', text: 'Not enough movement in this window to draw a route.' }),
          m, last ? h('p', null, h('a', { href: mapUrl(last.lat, last.lon), target: '_blank', rel: 'noopener', text: 'Open latest position in Google Maps ↗' })) : null);
      } catch (err) {
        histBox.replaceChildren(h('div', { class: 'empty', text: 'History couldn’t load. ' + friendly(err) }));
      }
    };

    const eventRows = events.map((e) => h('tr', null,
      h('td', { class: 'first', 'data-label': 'When', text: fmtTime(e.at) }),
      h('td', { 'data-label': 'Event', text: e.event }),
      h('td', { 'data-label': 'Peak', text: present(e.peak_g) ? num(e.peak_g, 1) + ' g' : '—' }),
      h('td', { 'data-label': 'Map' }, present(e.lat) ? h('a', { href: mapUrl(e.lat, e.lon), target: '_blank', rel: 'noopener', text: 'Map ↗' }) : '—')));

    const team = ROLE_FIELDS.map(([k, label]) => kv(label, t[k]));
    app.replaceChildren(
      h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
      h('h1', { class: 'title' }, t.truck_id, t.truck_name ? h('span', { class: 'sub', text: ' · ' + t.truck_name }) : null),
      h('div', { class: 'meta' }, statusPill(t.status), healthPill(t.health), t.warnings ? h('span', { class: 'why', text: t.warnings }) : null,
        h('span', { text: 'Last report ' + ago(t.minutes_since_seen) }),
        isAdmin() ? h('a', { href: '#edit-' + encodeURIComponent(t.truck_id), text: 'Edit truck' }) : null,
        h('a', { class: 'btn ghost small', href: '#customer-' + encodeURIComponent(t.truck_id), text: 'View customer page' })),
      h('div', { class: 'section-head' }, h('h2', { text: 'Right now' }), h('p', { class: 'note', text: 'Latest report. Equipment this truck doesn’t have is left out.' })),
      h('div', { class: 'panels' }, nowPanels),
      h('div', { class: 'section-head' }, h('h2', { text: 'Maintenance' }), h('p', { class: 'note', text: 'Overdue items turn the truck to Warning. Generator oil goes by the hour meter.' })),
      maintTable(maintRows),
      h('div', { class: 'section-head' }, h('h2', { text: 'Truck details' })),
      h('div', { class: 'panels' },
        panel('Build and delivery', kv('Build date', t.build_date), kv('Delivery date', t.delivery_date), kv('In service', t.in_service)),
        panel('Address', h('address', { class: 'addr' }, [t.address_line1, t.address_line2, t.address_city, t.address_country].filter(present).map((x) => h('span', { text: x })))),
        panel('Contact', kv('Name', t.contact_name), kv('Title', t.contact_title),
          h('div', { class: 'kv' }, h('span', { text: 'Phone' }), t.contact_phone ? h('a', { href: 'tel:' + String(t.contact_phone).replace(/[^0-9+]/g, ''), text: t.contact_phone }) : h('b', { text: '—' })),
          h('div', { class: 'kv' }, h('span', { text: 'Email' }), t.contact_email ? h('a', { href: 'mailto:' + t.contact_email, text: t.contact_email }) : h('b', { text: '—' }))),
        panel('Farber team', team)),
      h('div', { class: 'section-head' }, h('h2', { text: 'History' }), seg),
      histBox,
      routeBox,
      h('div', { class: 'section-head' }, h('h2', { text: 'Events' }), h('p', { class: 'note', text: 'Last 30 days' })),
      h('div', { class: 'card scroll' }, eventRows.length ? h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['When', 'Event', 'Peak', 'Map'].map((x) => h('th', { text: x })))),
        h('tbody', null, eventRows)) : h('p', { class: 'muted', text: 'No events in the last 30 days.' })));
    loadHistory();
  };

  // ---------- offline and shocks
  const renderWarnings = async (r, token) => {
    const fleet = await rpc('web_fleet');
    if (token !== renderToken) return;
    const rows = fleet.filter((t) => t.health === 'Warning')
      .map((t) => ({ ...t, list: String(t.warnings || '').split(', ').filter(Boolean) }))
      .sort((a, b) => b.list.length - a.list.length || String(a.truck_id).localeCompare(String(b.truck_id)));
    app.replaceChildren(
      h('a', { class: 'back', href: '#trucks', text: '← All trucks' }),
      h('h1', { class: 'title', text: `Trucks with warnings (${rows.length})` }),
      h('p', { class: 'lede', text: 'Every truck with something that needs attention, most warnings first. Open a truck to see the details.' }),
      rows.length ? h('div', { class: 'card scroll' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['Truck', 'Warnings', 'Status', 'Last update'].map((x) => h('th', { text: x })))),
        h('tbody', null, rows.map((t) => h('tr', null,
          h('td', { class: 'first', 'data-label': 'Truck' }, h('a', { href: '#truck-' + encodeURIComponent(t.truck_id), text: t.truck_id + (t.truck_name ? ' · ' + t.truck_name : '') })),
          h('td', { 'data-label': 'Warnings' }, h('ul', { class: 'warn-list' }, t.list.map((w) => h('li', { text: w })))),
          h('td', { 'data-label': 'Status' }, statusPill(t.status)),
          h('td', { 'data-label': 'Last update', text: t.last_seen ? `${fmtTime(t.last_seen)} (${ago(t.minutes_since_seen)})` : 'Never reported' }))))))
        : h('div', { class: 'empty', text: 'No warnings. Every truck is good.' }));
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
      const rows = data.trucks.filter((t) => !q || [t.truck_id, t.name, t.contact_name, t.city].some((v) => String(v || '').toLowerCase().includes(q)));
      list.replaceChildren(...(rows.length ? rows.map((t) => h('a', { class: 'row', href: '#edit-' + encodeURIComponent(t.truck_id) },
        h('span', { class: 'plate', text: t.truck_id }),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-name' + (t.name ? '' : ' unnamed'), text: t.name || 'No name set' }),
          h('span', { class: 'row-sub', text: [t.contact_name, [t.city, t.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No contact or address yet' })),
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
    const nums = data.trucks.map((x) => Number(x.truck_id)).filter((n) => Number.isInteger(n) && n > 0);
    const idField = isNew ? field('Truck number', { autocomplete: 'off', inputmode: 'numeric', maxlength: '32' }) : null;
    if (idField) idField.input.value = nums.length ? String(Math.max(...nums) + 1) : '';

    const snapshot = () => JSON.stringify({ v: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'date' ? el.value : clean(el.value)])),
      team: Object.fromEntries(Object.entries(selects).map(([k, el]) => [k, el.value])) });
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
      h('fieldset', null, h('legend', { text: 'Address' }), h('div', { class: 'grid' },
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
      let newId = null;
      if (isNew) {
        newId = clean(idField.input.value);
        if (!ID_OK.test(newId)) problems.push('Truck numbers can only use letters, numbers, - and _.');
        else if (data.trucks.some((x) => x.truck_id.toLowerCase() === newId.toLowerCase())) problems.push(`Truck ${newId} is already in the database.`);
      }
      if (problems.length) { status.className = 'status bad'; status.textContent = problems.join(' '); return; }
      const payload = { ...v, team: Object.fromEntries(Object.entries(selects).map(([k, el]) => [k, el.value])) };
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

  // ---------- customer portal: the customer's own truck, current information only
  const renderCustomer = async (r, token) => {
    let t, maint, mine = [];
    try {
      [t, maint, mine] = await Promise.all([
        rpc('web_customer_truck', { p_truck: r.id }),
        rpc('web_customer_maint', { p_truck: r.id }),
        isCustomer() ? rpc('web_my_trucks') : Promise.resolve([])]);
    } catch (err) {
      if (!/Not allowed/i.test(err.message || '')) throw err;
      app.replaceChildren(h('div', { class: 'empty', text: 'This truck isn’t linked to your account.' },
        isCustomer() ? h('div', { style: 'margin-top:12px' }, h('a', { class: 'btn ghost', href: '#mytrucks', text: 'My trucks' })) : null));
      return;
    }
    if (token !== renderToken) return;
    if (!t) { app.replaceChildren(h('div', { class: 'empty', text: `There is no truck ${r.id}.` })); return; }
    const { nowPanels, maintRows } = nowPanelsFor(t, maint, true);
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
      h('div', { class: 'section-head' }, h('h2', { text: 'Right now' }), h('p', { class: 'note', text: 'Latest report from your truck.' })),
      h('div', { class: 'panels' }, nowPanels),
      h('div', { class: 'section-head' }, h('h2', { text: 'Maintenance' })),
      maintTable(maintRows),
      h('div', { class: 'section-head' }, h('h2', { text: 'Truck details' })),
      h('div', { class: 'panels' }, panel('Build and delivery', kv('Build date', t.build_date), kv('Delivery date', t.delivery_date), kv('In service', t.in_service))),
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
    const showCode = (res, what) => {
      const site = location.origin + location.pathname;
      const msg = `You've been added to Farber Fleet.\nSite: ${site}\nPress "First time here", use ${res.email}, choose a password, and enter this code: ${res.code}\nThe code works until ${fmtDay(res.expires)}.`;
      const copyStatus = h('span', { class: 'status' });
      const pre = h('pre', { class: 'code', text: msg });
      codeBox.hidden = false;
      codeBox.replaceChildren(
        h('strong', { text: `${what} ${res.email}` }),
        h('p', null, 'Invite code: ', h('span', { class: 'codebig', text: res.code })),
        h('p', { class: 'note', text: 'Give this message to the person (text, email or in person). The code is shown only now and works once.' }),
        pre,
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Copy message', onclick: async () => {
          try { await navigator.clipboard.writeText(msg); copyStatus.textContent = 'Copied'; }
          catch (e) { const rg = document.createRange(); rg.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); copyStatus.textContent = 'Selected: use your device’s Copy'; }
        } }), copyStatus));
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
