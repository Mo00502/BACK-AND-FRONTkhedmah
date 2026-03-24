/**
 * Khedmah API Client — shared across all 36 pages
 *
 * Usage:  const data = await API.auth.login(email, password);
 *
 * Auto-handles:
 *  - Authorization: Bearer <token> headers
 *  - 401 → silent token refresh → retry once → redirect to login
 *  - Response unwrapping  ({ success, data } → returns data directly)
 *  - Structured error objects  { status, message, errors[] }
 *
 * Config (set before loading this script if needed):
 *  window.KHEDMAH_API_URL = 'https://api.khedmah.sa/api/v1';  // defaults below
 */

(function () {
  'use strict';

  /* ─── Configuration ──────────────────────────────────────────────────────── */

  const BASE = (window.KHEDMAH_API_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');

  /* ─── Storage helpers ────────────────────────────────────────────────────── */

  const Store = {
    get:    (k)    => { try { return localStorage.getItem(k); } catch { return null; } },
    set:    (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    remove: (k)    => { try { localStorage.removeItem(k); } catch {} },

    getAccessToken:  () => Store.get('khedmah_access_token'),
    getRefreshToken: () => Store.get('khedmah_refresh_token'),
    getTokenId:      () => Store.get('khedmah_token_id'),

    saveTokens(accessToken, tokenId, refreshToken) {
      Store.set('khedmah_access_token',  accessToken);
      Store.set('khedmah_token_id',      tokenId);
      Store.set('khedmah_refresh_token', refreshToken);
    },

    saveUser(user) {
      // Normalise role to lowercase so existing auth-guard checks (role==='provider') keep working
      const saved = { ...user, role: (user.role || '').toLowerCase() };
      Store.set('khedmah_user',  JSON.stringify(saved));
      // Keep the demo flag so existing auth-guard code keeps working
      Store.set('khedmah_demo', '1');
      const r = saved.role;
      if (r === 'admin' || r === 'super_admin' || r === 'support') {
        Store.set('khedmah_admin', JSON.stringify({ loggedIn: true, username: user.username }));
      }
    },

    clearAll() {
      ['khedmah_access_token', 'khedmah_refresh_token', 'khedmah_token_id',
       'khedmah_demo', 'khedmah_user', 'khedmah_admin'].forEach(k => Store.remove(k));
    },

    getUser() {
      try { return JSON.parse(Store.get('khedmah_user') || 'null'); } catch { return null; }
    },
  };

  /* ─── Error class ────────────────────────────────────────────────────────── */

  class ApiError extends Error {
    constructor(status, message, errors) {
      super(message);
      this.status = status;
      this.errors = errors || [];
      this.name   = 'ApiError';
    }
  }

  /* ─── Core fetch wrapper ─────────────────────────────────────────────────── */

  let _refreshing = null; // singleton promise during token refresh

  async function _fetch(method, path, body, opts = {}) {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;

    const headers = { 'Content-Type': 'application/json' };
    if (!opts.skipAuth) {
      const token = Store.getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 15000);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body:   body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        toast('انتهت مهلة الطلب، حاول مرة أخرى', 'danger');
        throw new ApiError(0, 'انتهت مهلة الطلب، حاول مرة أخرى');
      }
      throw e;
    }
    clearTimeout(timeoutId);

    // 401 → try silent refresh once
    if (res.status === 401 && !opts.skipAuth && !opts._retried) {
      const refreshed = await _tryRefresh();
      if (refreshed) {
        return _fetch(method, path, body, { ...opts, _retried: true });
      }
      // Refresh failed — clear session and send to login
      const role = Store.getUser()?.role;   // read role BEFORE clearing
      Store.clearAll();
      toast('انتهت جلستك، يُرجى تسجيل الدخول مجدداً', 'warning');
      const loginPage = (role === 'admin' || role === 'ADMIN' || role === 'super_admin' || role === 'SUPER_ADMIN')
        ? 'admin-login.html' : 'login.html';
      setTimeout(() => { window.location.href = loginPage; }, 500);
      throw new ApiError(401, 'انتهت جلستك. يرجى تسجيل الدخول مجدداً.');
    }

    // Parse JSON (some endpoints return 204 with no body)
    let json = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      json = await res.json();
    }

    if (!res.ok) {
      const msg    = json?.message || _httpMessage(res.status);
      const errors = Array.isArray(json?.errors) ? json.errors : [];
      throw new ApiError(res.status, msg, errors);
    }

    // Unwrap the ResponseInterceptor envelope: { success, data, meta, ... }
    if (json?.data !== undefined) return json.data;
    if (json?.success !== false)  return json;
    throw new ApiError(res.status, json?.message || _httpMessage(res.status));
  }

  async function _tryRefresh() {
    if (_refreshing) return _refreshing;

    const tokenId      = Store.getTokenId();
    const refreshToken = Store.getRefreshToken();
    if (!tokenId || !refreshToken) return false;

    _refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/token/refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tokenId, refreshToken }),
        });
        if (!res.ok) return false;
        const json = await res.json();
        const d    = json?.data || json;
        Store.saveTokens(d.accessToken, d.tokenId, d.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        _refreshing = null;
      }
    })();

    return _refreshing;
  }

  function _httpMessage(status) {
    const map = {
      400: 'بيانات غير صحيحة',
      401: 'غير مصرح لك بالوصول',
      403: 'ليس لديك صلاحية',
      404: 'العنصر غير موجود',
      409: 'يوجد تعارض في البيانات',
      422: 'بيانات غير صالحة',
      429: 'طلبات كثيرة، يرجى الانتظار',
      500: 'خطأ في الخادم، يرجى المحاولة لاحقاً',
    };
    return map[status] || `خطأ ${status}`;
  }

  /* ─── HTTP shortcuts ─────────────────────────────────────────────────────── */

  const http = {
    get:    (path, opts)       => _fetch('GET',    path, null, opts),
    post:   (path, body, opts) => _fetch('POST',   path, body, opts),
    patch:  (path, body, opts) => _fetch('PATCH',  path, body, opts),
    put:    (path, body, opts) => _fetch('PUT',    path, body, opts),
    delete: (path, opts)       => _fetch('DELETE', path, null, opts),
  };

  /* ─── API namespaces ─────────────────────────────────────────────────────── */

  const auth = {
    async login(identifier, password) {
      const d = await http.post('/auth/login', { identifier, password }, { skipAuth: true });
      Store.saveTokens(d.accessToken, d.tokenId, d.refreshToken);
      // Fetch full user profile and persist
      const user = await auth.me();
      Store.saveUser(user);
      return user;
    },

    async registerCustomer(data) {
      return http.post('/auth/register/customer', data, { skipAuth: true });
    },

    async registerProvider(data) {
      return http.post('/auth/register/provider', data, { skipAuth: true });
    },

    async me() {
      return http.get('/auth/me');
    },

    async logout() {
      const tokenId = Store.getTokenId();
      try {
        await http.post('/auth/logout', tokenId ? { tokenId } : {});
      } catch { /* ignore network errors on logout */ }
      Store.clearAll();
    },

    async forgotPassword(email) {
      return http.post('/auth/forgot-password', { email }, { skipAuth: true });
    },

    async resetPassword(token, newPassword) {
      return http.post('/auth/reset-password', { token, newPassword }, { skipAuth: true });
    },

    async resendVerification(email) {
      return http.post('/auth/verify-email/resend', { email }, { skipAuth: true });
    },

    async changePassword(currentPassword, newPassword) {
      return http.patch('/auth/me/password', { currentPassword, newPassword });
    },

    isLoggedIn:  () => !!Store.getAccessToken(),
    currentUser: () => Store.getUser(),
    getRole:     () => Store.getUser()?.role || null,
  };

  const requests = {
    create: (data)           => http.post('/requests', data),
    list:   (params = {})    => http.get('/requests?' + new URLSearchParams(params)),
    get:    (id)             => http.get(`/requests/${id}`),
    cancel: (id)             => http.patch(`/requests/${id}/cancel`),

    // Provider actions
    submitQuote: (id, data)           => http.post(`/requests/${id}/quotes`, data),
    acceptQuote: (id, quoteId)        => http.patch(`/requests/${id}/quotes/${quoteId}/accept`),
    start:       (id)                 => http.patch(`/requests/${id}/start`),
    complete:    (id)                 => http.patch(`/requests/${id}/complete`),
    confirm:     (id)                 => http.post(`/requests/${id}/confirm`),
  };

  const payments = {
    initiate:    (requestId, data) => http.post(`/payments/requests/${requestId}/pay`, data),
    release:     (requestId)       => http.post(`/payments/requests/${requestId}/release`),
    status:      (paymentId)       => http.get(`/payments/${paymentId}/status`),
    escrow:      (requestId)       => http.get(`/payments/requests/${requestId}/escrow`),
  };

  const wallet = {
    balance:        ()          => http.get('/wallet/balance'),
    transactions:   (p = {})    => http.get('/wallet/transactions?' + new URLSearchParams(p)),
    withdraw:       (data)      => http.post('/wallet/withdraw', data),
    withdrawals:    (p = {})    => http.get('/wallet/withdrawals?' + new URLSearchParams(p)),
  };

  const providers = {
    getProfile:        (id)       => http.get(`/providers/${id}`),
    myProfile:         ()         => http.get('/providers/me/profile'),
    myEarnings:        ()         => http.get('/providers/me/earnings'),
    earningsDashboard: ()         => http.get('/providers/me/earnings/dashboard'),
    updateBank:        (data)     => http.patch('/providers/me/profile', data),
    submitDocs:        (data)     => http.post('/providers/me/documents', data),
    services:          ()         => http.get('/providers/me/skills'),
    addService:        (data)     => http.post('/providers/me/skills', data),
    updateSkill:       (id, data) => http.patch(`/providers/me/skills/${id}`, data),
    removeService:     (id)       => http.delete(`/providers/me/skills/${id}`),
    schedule:          ()         => http.get('/providers/me/availability'),
    saveSchedule:      (data)     => http.patch('/providers/me/availability', data),
  };

  const services = {
    list: (params = {}) => http.get('/services?' + new URLSearchParams(params)),
    get:  (id)          => http.get(`/services/${id}`),
  };

  const search = {
    providers: (params = {}) => http.get('/search/providers?' + new URLSearchParams(params)),
    services:  (q)           => http.get(`/search/services?q=${encodeURIComponent(q)}`),
  };

  const reviews = {
    create: (requestId, data) => http.post(`/reviews/requests/${requestId}`, data),
    list:   (providerId, p = {})  => http.get(`/reviews/providers/${providerId}?` + new URLSearchParams(p)),
  };

  const notifications = {
    list:      (p = {})  => http.get('/notifications?' + new URLSearchParams(p)),
    markRead:  (id)      => http.patch(`/notifications/${id}/read`),
    markAllRead: ()      => http.patch('/notifications/read-all'),
    registerToken: (data) => http.post('/notifications/device-token', data),
  };

  const chat = {
    conversations:   ()              => http.get('/chat/conversations'),
    unread:          ()              => http.get('/chat/unread'),
    messages:        (id, p = {})    => http.get(`/chat/conversations/${id}/messages?` + new URLSearchParams(p)),
    send:            (id, data)      => http.post(`/chat/conversations/${id}/messages`, data),
    createDirect:    (userId)        => http.post(`/chat/direct/${userId}`, {}),
    createForRequest:(requestId)     => http.post(`/chat/request/${requestId}`, {}),
    createForTender: (tenderId)      => http.post(`/chat/tender/${tenderId}`, {}),
    // markRead: no backend endpoint exists — unread count clears on next message fetch
  };

  const admin = {
    dashboard:           ()       => http.get('/admin/dashboard'),
    stats:               ()       => http.get('/admin/dashboard'),          // alias
    monthlyStats:        ()       => http.get('/admin/stats/monthly'),
    users:               (p = {}) => http.get('/users?' + new URLSearchParams(p)),
    suspendUser:         (id, data) => http.post(`/admin/users/${id}/suspend`, data),
    unsuspendUser:       (id)     => http.post(`/admin/users/${id}/reinstate`),
    pendingProviders:    ()       => http.get('/admin/verifications/pending'),
    approveProvider:     (id)     => http.patch(`/admin/verifications/${id}/approve`),
    rejectProvider:      (id, data) => http.patch(`/admin/verifications/${id}/reject`, data),
    disputes:            (p = {}) => http.get('/admin/disputes?' + new URLSearchParams(p)),
    resolveDispute:      (id, data) => http.post(`/admin/disputes/${id}/resolve`, data),
    withdrawals:         (p = {}) => http.get('/wallet/admin/withdrawals?' + new URLSearchParams(p)),
    approveWithdrawal:   (id, data) => http.patch(`/wallet/admin/withdrawals/${id}/approve`, data),
    rejectWithdrawal:    (id, data) => http.patch(`/wallet/admin/withdrawals/${id}/reject`, data),
    health:              ()       => http.get('/admin/health'),
    weeklyReport:        ()       => http.get('/admin/reports/weekly'),
    overdueCommissions:  ()       => http.get('/admin/commissions/overdue'),
    consultations:       (p = {}) => http.get('/admin/consultations?' + new URLSearchParams(p)),
    cancelConsultation:  (id, data) => http.patch(`/admin/consultations/${id}/cancel`, data),
    support: {
      list:          (p = {})     => http.get('/support/admin/tickets?' + new URLSearchParams(p)),
      get:           (id)         => http.get(`/support/admin/tickets/${id}`),
      reply:         (id, data)   => http.post(`/support/admin/tickets/${id}/messages`, data),
      assign:        (id, data)   => http.patch(`/support/admin/tickets/${id}/assign`, data),
      updateStatus:  (id, status) => http.patch(`/support/admin/tickets/${id}/status`, { status }),
      close:         (id)         => http.patch(`/support/admin/tickets/${id}/status`, { status: 'CLOSED' }),
      sla:           ()           => http.get('/support/admin/sla'),
    },
  };

  const tenders = {
    list:       (p = {})      => http.get('/tenders?' + new URLSearchParams(p)),
    get:        (id)          => http.get(`/tenders/${id}`),
    create:     (data)        => http.post('/tenders', data),
    bid:        (id, data)    => http.post(`/tenders/${id}/bids`, data),
    award:      (id, bidId)   => http.post(`/tenders/${id}/award/${bidId}`),
    milestones: (id)          => http.get(`/tenders/${id}/milestones`),
    releaseMilestone: (tenderId, milestoneId) => http.post(`/tenders/${tenderId}/milestones/${milestoneId}/release`),
    close:      (id)          => http.patch(`/tenders/${id}/close`, {}),
  };

  const invoices = {
    list:         (params)  => http.get('/invoices/my', { params }),
    get:          (id)      => http.get(`/invoices/${id}`),
    service:      (id)      => http.get(`/invoices/service/${id}`),
    tender:       (id)      => http.get(`/invoices/tender/${id}`),
    equipment:    (id)      => http.get(`/invoices/equipment/${id}`),
    consultation: (id)      => http.get(`/invoices/consultation/${id}`),
  };

  const referrals = {
    my:    ()         => http.get('/referrals/my'),
    list:  (params)   => http.get('/referrals', { params }),
    stats: ()         => http.get('/referrals/stats'),
  };

  const rewards = {
    my:       ()       => http.get('/rewards/my'),
    referrals: ()      => http.get('/rewards/referrals'),
    redeem:   (amount) => http.post('/rewards/redeem', { amount }),
  };

  const equipment = {
    list:   (p = {})   => http.get('/equipment?' + new URLSearchParams(p)),
    get:    (id)       => http.get(`/equipment/${id}`),
    rent:   (id, data) => http.post(`/equipment/${id}/rentals`, data),
    myRentals: ()      => http.get('/equipment/rentals/mine'),
    myListings: ()     => http.get('/equipment/mine'),
  };

  const consultations = {
    list:         (p = {})    => http.get('/consultations?' + new URLSearchParams(p)),
    book:         (data)      => http.post('/consultations', data),
    get:          (id)        => http.get(`/consultations/${id}`),
    accept:       (id)        => http.patch(`/consultations/${id}/accept`),
    complete:     (id)        => http.patch(`/consultations/${id}/complete`),
    cancel:       (id)        => http.patch(`/consultations/${id}/cancel`),
    rate:         (id, data)  => http.post(`/consultations/${id}/rate`, data),
    reject:       (id)        => http.patch(`/consultations/${id}/reject`),
    startSession: (id)        => http.patch(`/consultations/${id}/start`),
  };

  const disputes = {
    list:        (p = 1)   => http.get(`/disputes?page=${p}`),
    get:         (id)      => http.get(`/disputes/${id}`),
    open:        (data)    => http.post('/disputes', data),
    addEvidence: (id, data) => http.post(`/disputes/${id}/evidence`, data),
    escalate:    (id)      => http.post(`/disputes/${id}/escalate`),
  };

  const support = {
    list:   (p = 1)       => http.get(`/support/tickets?page=${p}`),
    get:    (id)          => http.get(`/support/tickets/${id}`),
    create: (data)        => http.post('/support/tickets', data),
    reply:  (id, data)    => http.post(`/support/tickets/${id}/messages`, data),
    // Note: closing a ticket is an admin-only action (PATCH /support/admin/tickets/:id/status).
    // Use admin.support.updateStatus() from the admin namespace instead.
  };

  const maps = {
    geocode:      (address) => http.get(`/maps/geocode?address=${encodeURIComponent(address)}`),
    distance:     (o, d)    => http.get(`/maps/distance?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}`),
    autocomplete: (q, tok)  => http.get(`/maps/autocomplete?q=${encodeURIComponent(q)}&sessionToken=${tok}`),
  };

  /* ─── Toast / UI helpers ─────────────────────────────────────────────────── */

  /**
   * Show a simple Bootstrap toast message.
   * Assumes a <div id="api-toast"> exists — injects one if not.
   */
  function toast(message, type = 'danger') {
    let container = document.getElementById('api-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'api-toast-container';
      container.style.cssText = 'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:9999;min-width:320px;';
      document.body.appendChild(container);
    }
    const id  = 'toast-' + Date.now();
    const bg  = type === 'success' ? '#198754' : type === 'warning' ? '#fd7e14' : '#dc3545';
    container.insertAdjacentHTML('beforeend', `
      <div id="${id}" style="background:${bg};color:#fff;border-radius:8px;padding:.9rem 1.2rem;
           margin-bottom:.5rem;box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:.92rem;
           animation:fadeIn .2s ease;direction:rtl">
        ${message}
      </div>`);
    setTimeout(() => document.getElementById(id)?.remove(), type === 'danger' ? 6000 : 4000);
  }

  /** Extract a user-facing error message from an ApiError or unknown error. */
  function errorMsg(err) {
    if (err instanceof ApiError) {
      if (err.errors?.length) return err.errors.join(' ، ');
      return err.message;
    }
    return 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً.';
  }

  /* ─── Export ─────────────────────────────────────────────────────────────── */

  window.API = {
    // HTTP primitives (advanced use)
    get:    http.get,
    post:   http.post,
    patch:  http.patch,
    put:    http.put,
    delete: http.delete,

    // Domain namespaces
    auth, requests, payments, wallet, providers, services,
    search, reviews, notifications, chat, admin, tenders,
    invoices, referrals, rewards, equipment, consultations, disputes, support, maps,

    // Auth helpers (frequently needed in guards)
    isLoggedIn:  auth.isLoggedIn,
    currentUser: auth.currentUser,
    getRole:     auth.getRole,

    // Storage
    Store,

    // UI helpers
    toast,
    errorMsg,
    ApiError,
  };

  /* ─── CSS for toast fade-in ─────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = '@keyframes fadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}';
  document.head.appendChild(style);

})();
