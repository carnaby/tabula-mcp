/**
 * The one script of the auth pages: WebAuthn in the browser without dependencies, talking only to this origin. The
 * page says what to do in data attributes: data-mode (signin | register), data-next, data-token, data-auto.
 */
export const PASSKEY_SCRIPT = String.raw`'use strict';
(function () {
  function toBuf(s) {
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function toB64u(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.message || 'The server refused the request.');
          return data;
        });
      });
  }
  function status(text) {
    var el = document.getElementById('status');
    if (el) el.textContent = text;
  }
  function descriptors(list) {
    return (list || []).map(function (c) { return { type: 'public-key', id: toBuf(c.id), transports: c.transports }; });
  }
  function common(cred) {
    return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment || undefined };
  }
  function signIn() {
    return post('/auth/passkey/login/options', {}).then(function (r) {
      var o = r.options;
      return navigator.credentials.get({ publicKey: { challenge: toBuf(o.challenge), rpId: o.rpId, timeout: o.timeout,
        userVerification: o.userVerification, allowCredentials: descriptors(o.allowCredentials) } });
    }).then(function (cred) {
      var a = cred.response;
      var response = common(cred);
      response.response = { clientDataJSON: toB64u(a.clientDataJSON), authenticatorData: toB64u(a.authenticatorData),
        signature: toB64u(a.signature), userHandle: a.userHandle ? toB64u(a.userHandle) : undefined };
      return post('/auth/passkey/login/verify', { response: response });
    });
  }
  function register(token, name) {
    return post('/auth/passkey/register/options', { token: token }).then(function (r) {
      var o = r.options;
      return navigator.credentials.create({ publicKey: { challenge: toBuf(o.challenge), rp: o.rp,
        user: { id: toBuf(o.user.id), name: o.user.name, displayName: o.user.displayName }, pubKeyCredParams: o.pubKeyCredParams,
        timeout: o.timeout, attestation: o.attestation, authenticatorSelection: o.authenticatorSelection,
        excludeCredentials: descriptors(o.excludeCredentials), extensions: o.extensions } });
    }).then(function (cred) {
      var a = cred.response;
      var response = common(cred);
      response.response = { clientDataJSON: toB64u(a.clientDataJSON), attestationObject: toB64u(a.attestationObject),
        transports: a.getTransports ? a.getTransports() : [] };
      return post('/auth/passkey/register/verify', { token: token, name: name, response: response });
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var body = document.body;
    var mode = body.getAttribute('data-mode');
    var next = body.getAttribute('data-next') || '/';
    var button = document.getElementById('go');
    if (!button || !mode) return;
    if (!window.PublicKeyCredential) {
      status('This browser does not support passkeys.');
      button.disabled = true;
      return;
    }
    function run() {
      button.disabled = true;
      status(mode === 'register' ? 'Follow your browser to create the passkey…' : 'Waiting for your passkey…');
      var nameField = document.getElementById('name');
      var done = mode === 'register' ? register(body.getAttribute('data-token'), nameField ? nameField.value : '') : signIn();
      done.then(function () {
        status('Done.');
        location.assign(next);
      }, function (e) {
        button.disabled = false;
        status(e && e.name === 'NotAllowedError' ? 'Cancelled or timed out. Try again.' : (e && e.message) || 'Something went wrong. Try again.');
      });
    }
    button.addEventListener('click', run);
    if (mode === 'signin' && body.getAttribute('data-auto') === '1') run();
  });
})();
`;
