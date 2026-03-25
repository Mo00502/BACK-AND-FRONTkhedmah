// Shared API client for Payout System
// All pages include this via <script src="js/api.js"></script>

const API_BASE = 'http://localhost:3000/api/v1';

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function apiFetch(path, opts = {}) {
  const token = localStorage.getItem('access_token');
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { localStorage.clear(); location.href = '/login.html'; return; }
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'Request failed');
  return json.data ?? json;
}

const API = {
  auth: {
    login:    (data) => apiFetch('/auth/login',    { method: 'POST', body: JSON.stringify(data) }),
    register: (data) => apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    logout:   ()     => apiFetch('/auth/logout',   { method: 'POST' }),
  },
  orders: {
    create:   (data) => apiFetch('/orders',              { method: 'POST', body: JSON.stringify(data) }),
    get:      (id)   => apiFetch(`/orders/${id}`),
    list:     ()     => apiFetch('/orders/my'),
    accept:   (id)   => apiFetch(`/orders/${id}/accept`,   { method: 'POST' }),
    start:    (id)   => apiFetch(`/orders/${id}/start`,    { method: 'POST' }),
    complete: (id)   => apiFetch(`/orders/${id}/complete`, { method: 'POST' }),
    release:  (id)   => apiFetch(`/orders/${id}/release`,  { method: 'POST' }),
    cancel:   (id)   => apiFetch(`/orders/${id}/cancel`,   { method: 'POST' }),
  },
  payments: {
    initiate: (data)    => apiFetch('/payments/initiate',        { method: 'POST', body: JSON.stringify(data) }),
    status:   (orderId) => apiFetch(`/payments/status/${orderId}`),
  },
  payouts: {
    bankAccounts:   ()     => apiFetch('/payouts/bank-accounts'),
    addBankAccount: (data) => apiFetch('/payouts/bank-account', { method: 'POST', body: JSON.stringify(data) }),
    setDefault:     (id)   => apiFetch(`/payouts/bank-account/${id}/default`, { method: 'PATCH' }),
    deleteBankAccount: (id) => apiFetch(`/payouts/bank-account/${id}`, { method: 'DELETE' }),
    request:        (data) => apiFetch('/payouts/request',      { method: 'POST', body: JSON.stringify(data) }),
    history:        ()     => apiFetch('/payouts/history'),
    retry:          (id)   => apiFetch(`/payouts/${id}/retry`,  { method: 'POST' }),
  },
  wallet: {
    balance: () => apiFetch('/wallet/balance'),
  },
  notifications: {
    list:       ()   => apiFetch('/notifications'),
    markRead:   (id) => apiFetch(`/notifications/${id}/read`,   { method: 'PATCH' }),
    markAllRead: ()  => apiFetch('/notifications/read-all',     { method: 'PATCH' }),
  },
};
