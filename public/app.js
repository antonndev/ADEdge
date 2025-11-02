// public/app.js
document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  // Toast refs (popup sus dreapta)
  const toastBox = document.getElementById('edge-toast');
  const toastMsg = document.getElementById('edge-toast-msg');
  const toastIcon = document.getElementById('edge-toast-icon');
  const toastClose = document.getElementById('edge-toast-close');
  let edgeToastTimer = null;

  function hideEdgeToast() {
    if (!toastBox) return;
    toastBox.classList.remove('show');
  }

  function showEdgeToast(message, ok = true) {
    if (!toastBox || !toastMsg || !toastIcon) return;
    toastBox.dataset.type = ok ? 'ok' : 'error';
    toastMsg.textContent = message;

    if (ok) {
      toastIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"/>
        </svg>`;
    } else {
      toastIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>`;
    }

    toastBox.classList.add('show');
    clearTimeout(edgeToastTimer);
    edgeToastTimer = setTimeout(() => {
      hideEdgeToast();
    }, 4000);
  }

  if (toastClose) {
    toastClose.addEventListener('click', () => {
      hideEdgeToast();
      clearTimeout(edgeToastTimer);
    });
  }

  if (toastBox) {
    toastBox.addEventListener('mouseenter', () => {
      clearTimeout(edgeToastTimer);
    });
    toastBox.addEventListener('mouseleave', () => {
      clearTimeout(edgeToastTimer);
      edgeToastTimer = setTimeout(() => {
        hideEdgeToast();
      }, 2000);
    });
  }

  // detectăm dacă suntem pe pagina de settings
  const onSettingsPage = window.location.pathname.includes('settings');

  // ------------------ DOM refs generale (dashboard upload/gallery/etc) ------------------
  const uploadForm = document.getElementById('uploadForm');
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const filePreview = document.getElementById('filePreview');
  const genBinary = document.getElementById('genBinary');
  const genMultipart = document.getElementById('genMultipart');
  const downloadLink = document.getElementById('downloadLink');
  const createAccountModal = document.getElementById('createAccountModal');
  const imagesGrid = document.getElementById('imagesGrid');
  const galleryEmpty = document.getElementById('galleryEmpty');

  // ---- Change Informations DOM (email change) ----
  const infoForm = document.getElementById('infoForm');               // form Change Informations
  const emailInput = document.getElementById('emailInput');           // current email (readonly/disabled in UI)
  const updatedEmailInput = document.getElementById('updatedEmail');  // new email input
  const infoStatus = document.getElementById('infoStatus');           // status line sub Save

  if (dropzone && fileInput) initDragDrop(dropzone, fileInput);
  if (fileInput) fileInput.addEventListener('change', () => showPreview(fileInput, filePreview));
  if (uploadForm) uploadForm.addEventListener('submit', e => handleUpload(e, fileInput));
  if (genBinary) genBinary.addEventListener('click', () => generateSxcu('binary', downloadLink));
  if (genMultipart) genMultipart.addEventListener('click', () => generateSxcu('multipart', downloadLink));
  if (imagesGrid) loadGallery(imagesGrid, galleryEmpty);

  // ------------------ DOM refs settings ------------------
  const settingsNav = document.getElementById('settingsNav');
  const settingsPanels = document.querySelectorAll('[data-settings-panel]');
  const navButtons = settingsNav ? Array.from(settingsNav.querySelectorAll('[data-panel-target]')) : [];
  const backgroundFileName = document.getElementById('backgroundFileName');
  const backgroundUploadLabel = document.getElementById('backgroundUploadLabel');

  let activePanel = 'preferences';

  function switchSettingsPanel(id) {
    if (!id) return;
    activePanel = id;
    navButtons.forEach(btn => {
      const isActive = btn.dataset.panelTarget === id;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    settingsPanels.forEach(panel => {
      const match = panel.dataset.settingsPanel === id;
      panel.classList.toggle('is-active', match);
    });
  }

  if (settingsNav && navButtons.length) {
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.panelTarget;
        if (!target) return;
        switchSettingsPanel(target);
      });
    });

    switchSettingsPanel(activePanel);

    settingsNav.addEventListener('pointermove', evt => {
      const rect = settingsNav.getBoundingClientRect();
      const x = ((evt.clientX - rect.left) / rect.width) * 100;
      const y = ((evt.clientY - rect.top) / rect.height) * 100;
      settingsNav.style.setProperty('--cursor-x', `${x}%`);
      settingsNav.style.setProperty('--cursor-y', `${y}%`);
      settingsNav.style.setProperty('--cursor-opacity', '0.75');
      settingsNav.classList.add('glow-active');
    });

    settingsNav.addEventListener('pointerleave', () => {
      settingsNav.style.setProperty('--cursor-opacity', '0');
      settingsNav.classList.remove('glow-active');
    });
  }

  // ---- background settings DOM ----
  const preferencesCard = document.getElementById('preferencesCard');
  const backgroundColorInput = document.getElementById('backgroundColor');
  const backgroundHexInput = document.getElementById('backgroundColorHex');
  const applyColorBtn = document.getElementById('applyColor');
  const backgroundUploadInput = document.getElementById('backgroundUpload');
  const backgroundUploadBtn = document.getElementById('uploadBackground');
  const backgroundTemplates = document.getElementById('backgroundTemplates');
  const preferencesStatus = document.getElementById('preferencesStatus');
  const resetBackgroundBtn = document.getElementById('resetBackground');

  const passwordForm = document.getElementById('passwordForm');
  const currentPasswordInput = document.getElementById('currentPassword');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmPasswordInput = document.getElementById('confirmPassword');
  const passwordStatus = document.getElementById('passwordStatus');

  // ---- admin accounts DOM ----
  const accountsCard = document.getElementById('accountsCard');
  const accountsList = document.getElementById('accountsList');
  const accountsStatus = document.getElementById('accountsStatus');
  const openCreateAccount = document.getElementById('openCreateAccount');
  const createAccountForm = document.getElementById('createAccountForm');
  const createAccountStatus = document.getElementById('createAccountStatus');

  // --- Registration lock UI refs (admin panel) ---
  const allowRegisterCard = document.getElementById('allowRegisterCard');
  const allowRegisterSegmented = document.getElementById('allowRegisterSegmented');
  const allowRegisterYes = document.getElementById('allowRegisterYes'); // Yes = BLOCK
  const allowRegisterNo = document.getElementById('allowRegisterNo');   // No = OPEN
  const registerStatus = document.getElementById('registerStatus');

  // ------------------ state ------------------
  let templatesList = [];
  let defaultBackground = { type: 'color', value: '#05080f' };
  let currentBackground = null;
  let accountProfile = null;
  let currentRegisterBlocked = null; // unknown at start

  // admin cache key
  const ADMIN_CACHE_KEY = 'edge_is_admin';

  function getCachedAdminFlag() {
    try {
      return localStorage.getItem(ADMIN_CACHE_KEY); // "1", "0", or null
    } catch (_) {
      return null;
    }
  }

  function cacheAdmin(isAdmin) {
    try {
      localStorage.setItem(ADMIN_CACHE_KEY, isAdmin ? '1' : '0');
    } catch (_) {}
    if (isAdmin) {
      document.documentElement.classList.remove('no-admin');
    } else {
      document.documentElement.classList.add('no-admin');
    }
  }

  function hideAdminUI() {
    // clasa globală => CSS ascunde tot ce e data-admin-only imediat
    document.documentElement.classList.add('no-admin');

    // runtime safety
    if (accountsCard) accountsCard.style.display = 'none';
    if (allowRegisterCard) allowRegisterCard.style.display = 'none';

    if (settingsNav) {
      const adminNavBtn = settingsNav.querySelector('[data-panel-target="admin"]');
      const adminPanel = document.querySelector('[data-settings-panel="admin"]');
      if (adminNavBtn && adminPanel) {
        adminNavBtn.setAttribute('hidden', 'hidden');
        adminNavBtn.classList.remove('active');
        adminPanel.classList.remove('is-active');
        adminPanel.setAttribute('hidden', 'hidden');
        if (activePanel === 'admin') {
          switchSettingsPanel('preferences');
        }
      }
    }
  }

  function showAdminUI() {
    document.documentElement.classList.remove('no-admin');

    if (accountsCard) accountsCard.style.display = '';
    if (allowRegisterCard) allowRegisterCard.style.display = '';

    if (settingsNav) {
      const adminNavBtn = settingsNav.querySelector('[data-panel-target="admin"]');
      const adminPanel = document.querySelector('[data-settings-panel="admin"]');
      if (adminNavBtn && adminPanel) {
        adminNavBtn.removeAttribute('hidden');
        adminPanel.removeAttribute('hidden');
      }
    }
  }

  // ------------------ event listeners pt background UI ------------------
  if (preferencesCard) {
    if (backgroundColorInput && backgroundHexInput) {
      backgroundColorInput.addEventListener('input', () => syncColorInputs(backgroundColorInput.value));
      backgroundHexInput.addEventListener('change', () => {
        const normalized = normalizeHex(backgroundHexInput.value);
        if (normalized) {
          backgroundColorInput.value = normalized;
          backgroundHexInput.value = normalized.toUpperCase();
        } else {
          setStatus(preferencesStatus, 'Use a valid hex color (e.g. #0A132A)', false);
        }
      });
    }

    if (applyColorBtn) {
      applyColorBtn.addEventListener('click', () => {
        const candidate = normalizeHex(backgroundHexInput?.value || backgroundColorInput?.value);
        if (!candidate) {
          setStatus(preferencesStatus, 'Pick a valid hex color first.', false);
          return;
        }
        saveLocalBackgroundPreference({ type: 'color', value: candidate });
      });
    }

    if (backgroundUploadBtn) {
      backgroundUploadBtn.addEventListener('click', () => handleLocalBackgroundUpload(backgroundUploadInput));
    }

    if (backgroundUploadInput) {
      backgroundUploadInput.addEventListener('change', () => {
        updateBackgroundFilename();
        if (backgroundUploadInput.files && backgroundUploadInput.files[0]) {
          setStatus(preferencesStatus, 'Custom image selected. Apply to preview it.', true);
        }
      });
    }

    if (resetBackgroundBtn) {
      resetBackgroundBtn.addEventListener('click', () => {
        saveLocalBackgroundPreference(Object.assign({}, defaultBackground));
      });
    }
  }

  if (backgroundFileName) {
    updateBackgroundFilename();
  }

  // ------------------ account / password listeners ------------------
  if (infoForm) {
    infoForm.addEventListener('submit', e => handleInfoSubmit(e));
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', e => handlePasswordChange(e));
  }

  // ------------------ admin accounts modal ------------------
  if (openCreateAccount && createAccountModal && createAccountForm) {
    openCreateAccount.addEventListener('click', () => openModal(createAccountModal));
    document.querySelectorAll('[data-close-modal]').forEach(btn =>
      btn.addEventListener('click', () => closeModal(createAccountModal))
    );
    createAccountModal.addEventListener('click', evt => {
      if (evt.target === createAccountModal) closeModal(createAccountModal);
    });
    createAccountForm.addEventListener('submit', e => handleCreateAccount(e));
  }

  // ===================== init flows =====================

  // 0. citim cache local => dacă știm deja "nu e admin", punem no-admin ASAP ca să nu apară tab-ul
  const cachedAdminFlag = getCachedAdminFlag();
  if (cachedAdminFlag === '0') {
    hideAdminUI();
  } else if (cachedAdminFlag === '1') {
    showAdminUI();
  }

  // 1. pune backgroundul din localStorage
  initLocalBackground();

  // 2. ia templates de pe server
  loadBackgroundOptions();

  // 3. profil user (email etc) / fallback bg / setează cache admin corect
  loadAccountProfile();

  // 4 & 5. dacă știm deja din cache că e admin sau încă nu știm deloc (null) => facem fetch admin
  if (cachedAdminFlag === '1' || cachedAdminFlag === null) {
    if (accountsCard) loadAccounts();
    initRegisterLock();
  }
  // dacă e "0", nu mai batem serverul pt admin deloc

  // ======================================================================================
  // ===========================   FUNCȚII   =============================================
  // ======================================================================================

  // ----- Dashboard helpers -----
  function getStoredToken() {
    return localStorage.getItem('uploadToken') || null;
  }

  function setStoredToken(token) {
    if (token) localStorage.setItem('uploadToken', token);
    else localStorage.removeItem('uploadToken');
  }

  async function handleUpload(event, inputEl) {
    event.preventDefault();
    const file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) {
      showEdgeToast('Please choose a file first.', false);
      return;
    }

    const fd = new FormData();
    fd.append('file', file);

    const token = getStoredToken();

    try {
      showEdgeToast('Uploading...', true);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: fd
      });
      if (!res.ok) throw new Error(await res.text());
      await res.json();
      showEdgeToast('Upload successful', true);
      if (imagesGrid) loadGallery(imagesGrid, galleryEmpty);
      if (filePreview) filePreview.innerHTML = '';
      if (inputEl) inputEl.value = '';
    } catch (err) {
      console.error(err);
      showEdgeToast('Upload failed: ' + (err.message || err), false);
    }
  }

  function showPreview(inputEl, previewEl) {
    if (!inputEl || !previewEl) return;
    const file = inputEl.files && inputEl.files[0];
    if (!file) {
      previewEl.innerHTML = '';
      return;
    }
    const url = URL.createObjectURL(file);
    previewEl.innerHTML = `<img src="${url}" alt="preview" style="width:56px;height:56px;border-radius:12px;object-fit:cover;">`;
  }

  async function generateSxcu(mode, outputEl) {
    try {
      showEdgeToast('Generating .sxcu...', true);
      const res = await fetch(`/api/generate-sxcu?mode=${encodeURIComponent(mode)}`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const fileName = `sharex-${mode}.sxcu`;
      if (outputEl) {
        outputEl.innerHTML = `
  <a class="btn subtle" href="${url}" download="${fileName}">
    <i class="fa-solid fa-download"></i> Download ${fileName}
  </a>`;
      }
      showEdgeToast('.sxcu generated', true);
    } catch (err) {
      console.error(err);
      showEdgeToast('Failed to generate .sxcu: ' + (err.message || err), false);
    }
  }

  async function loadGallery(gridEl, emptyState) {
    if (!gridEl) return;
    try {
      gridEl.innerHTML = '<div class="muted">Loading...</div>';
      const res = await fetch('/api/images');
      if (!res.ok) throw new Error('Failed to load images');
      const json = await res.json();
      const items = Array.isArray(json.images) ? json.images : [];
      if (!items.length) {
        gridEl.innerHTML = '';
        if (emptyState) emptyState.hidden = false;
        return;
      }
      if (emptyState) emptyState.hidden = true;
      gridEl.innerHTML = '';
      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'img-card';
        card.innerHTML = `
          <img src="${item.url}" alt="${escapeHtml(item.originalname || item.filename || 'upload')}">
          <div class="meta">
            <div class="meta-name">${escapeHtml(item.originalname || item.filename || '')}</div>
            <div><a class="link" href="${item.url}" target="_blank" rel="noopener">View</a></div>
          </div>`;
        gridEl.appendChild(card);
      });
    } catch (err) {
      console.error(err);
      gridEl.innerHTML = '<div class="muted">Failed to load gallery</div>';
    }
  }

  // ======================================================================================
  // =============== BACKGROUND LOCAL-ONLY LOGIC =========================================
  // ======================================================================================

  function initLocalBackground() {
    const raw = localStorage.getItem('bgPref');
    if (raw) {
      try {
        const pref = JSON.parse(raw);
        currentBackground = pref;
        applyBackground(pref);
        reflectBackground(pref);
        return;
      } catch (_) {}
    }
    // fallback first load
    currentBackground = Object.assign({}, defaultBackground);
    applyBackground(currentBackground);
    reflectBackground(currentBackground);
  }

  function applyBackground(pref) {
    if (!pref || !document.body) return;

    // curățăm ce era
    document.body.style.removeProperty('background-image');
    document.body.style.removeProperty('background-color');
    document.body.style.removeProperty('background');
    document.body.removeAttribute('data-bg-type');

    if (pref.type === 'color') {
      document.body.style.backgroundColor = pref.value;
      document.body.setAttribute('data-bg-type', 'color');
      return;
    }

    if (pref.type === 'template') {
      document.body.style.backgroundImage = `url('${pref.value}')`;
      document.body.setAttribute('data-bg-type', 'template');
      return;
    }

    if (pref.type === 'image') {
      document.body.style.backgroundImage = `url('${pref.value}')`;
      document.body.setAttribute('data-bg-type', 'image');
      return;
    }

    // fallback
    document.body.style.backgroundColor = defaultBackground.value;
    document.body.setAttribute('data-bg-type', 'color');
  }

  function saveLocalBackgroundPreference(pref) {
    if (!pref) return;
    try {
      localStorage.setItem('bgPref', JSON.stringify(pref));
    } catch (err) {
      console.warn('Could not save bgPref in localStorage', err);
    }
    setStatus(preferencesStatus, 'Preference successfully saved', true);
    applyBackground(pref);
    reflectBackground(pref);
  }

  function reflectBackground(pref) {
    if (!pref) return;
    currentBackground = pref;

    if (pref.type === 'color') {
      syncColorInputs(pref.value);
    }

    markTemplate(pref.type === 'template' ? pref.value : null);
  }

  async function loadBackgroundOptions() {
    if (!preferencesCard) return;
    try {
      const res = await fetch('/api/account/background/templates');
      if (!res.ok) throw new Error('Unable to load templates');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Unable to load templates');

      templatesList = Array.isArray(json.templates) ? json.templates : [];
      if (json.defaultBackground) defaultBackground = Object.assign({}, json.defaultBackground);

      renderTemplates();

      if (!currentBackground) {
        currentBackground = Object.assign({}, defaultBackground);
        applyBackground(currentBackground);
        reflectBackground(currentBackground);
      }
    } catch (err) {
      console.error(err);
      setStatus(preferencesStatus, 'Could not load templates.', false);
    }
  }

  function renderTemplates() {
    if (!backgroundTemplates) return;
    backgroundTemplates.innerHTML = '';
    templatesList.forEach(url => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'template-option';
      button.style.backgroundImage = `url('${url}')`;
      button.dataset.value = url;

      if (currentBackground &&
          currentBackground.type === 'template' &&
          currentBackground.value === url) {
        button.classList.add('active');
      }

      button.addEventListener('click', () => {
        saveLocalBackgroundPreference({ type: 'template', value: url });
      });

      backgroundTemplates.appendChild(button);
    });
  }

  function markTemplate(value) {
    if (!backgroundTemplates) return;
    const nodes = backgroundTemplates.querySelectorAll('.template-option');
    nodes.forEach(node => {
      const isActive = value && node.dataset.value === value;
      node.classList.toggle('active', isActive);
    });
  }

  function handleLocalBackgroundUpload(inputEl) {
    if (!inputEl || !inputEl.files || !inputEl.files[0]) {
      setStatus(preferencesStatus, 'Choose an image to upload.', false);
      return;
    }

    const file = inputEl.files[0];
    const reader = new FileReader();

    setStatus(preferencesStatus, 'Loading image locally...', true);

    reader.onload = e => {
      const dataUrl = e.target.result;
      saveLocalBackgroundPreference({ type: 'image', value: dataUrl });

      inputEl.value = '';
      updateBackgroundFilename();
      setStatus(preferencesStatus, 'Custom background applied locally.', true);
    };

    reader.onerror = () => {
      console.error('FileReader error');
      setStatus(preferencesStatus, 'Failed to load image.', false);
    };

    reader.readAsDataURL(file);
  }

  // ======================================================================================
  // =============== RESTUL FUNCȚIILOR DE FORM / ACCOUNT =================================
  // ======================================================================================

  function syncColorInputs(value) {
    if (!value || !backgroundColorInput || !backgroundHexInput) return;
    const normalized = normalizeHex(value);
    if (!normalized) return;
    backgroundColorInput.value = normalized;
    backgroundHexInput.value = normalized.toUpperCase();
  }

  function normalizeHex(value) {
    if (!value) return null;
    let v = value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
      if (v.length === 4) {
        v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      }
      return v.toLowerCase();
    }
    return null;
  }

  // status global prin toast
  function setStatus(el, message, ok = true) {
    if (el) {
      el.textContent = '';
    }
    showEdgeToast(message || '', ok);
  }

  function updateBackgroundFilename() {
    if (!backgroundFileName) return;
    const file = backgroundUploadInput && backgroundUploadInput.files && backgroundUploadInput.files[0];
    backgroundFileName.textContent = file ? file.name : 'No file selected';
    if (backgroundUploadLabel) {
      backgroundUploadLabel.classList.toggle('has-file', Boolean(file));
    }
  }

  async function handleInfoSubmit(e) {
    e.preventDefault();
    if (!infoStatus) return;

    const currentEmail = emailInput?.value?.trim() || '';
    const wantedEmail = updatedEmailInput?.value?.trim() || '';

    // validări front-end
    if (!wantedEmail) {
      setStatus(infoStatus, 'Please enter a new email first.', false);
      return;
    }

    if (wantedEmail === currentEmail) {
      setStatus(infoStatus, 'That is already your current email.', false);
      return;
    }

    // format email basic
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(wantedEmail)) {
      setStatus(infoStatus, 'Invalid email format.', false);
      return;
    }

    // cerem backend-ului update + verificare unicitate
    try {
      setStatus(infoStatus, 'Updating email…', true);

      const res = await fetch('/api/account/email', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ email: wantedEmail })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.success === false) {
        // aici backend poate trimite 409 "Email already in use"
        throw new Error(data.error || 'Failed to update email.');
      }

      // succes ✅
      if (emailInput) emailInput.value = data.email || wantedEmail;
      if (updatedEmailInput) updatedEmailInput.value = '';

      setStatus(infoStatus, 'Email updated.', true);
    } catch (err) {
      console.error(err);
      setStatus(infoStatus, err.message || 'Failed to update email.', false);
    }
  }

  async function handlePasswordChange(event) {
    event.preventDefault();
    if (!passwordStatus) return;
    const currentPassword = currentPasswordInput?.value || '';
    const newPassword = newPasswordInput?.value || '';
    const confirmPassword = confirmPasswordInput?.value || '';

    if (!currentPassword || !newPassword) {
      setStatus(passwordStatus, 'Fill in all password fields.', false);
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus(passwordStatus, 'New passwords do not match.', false);
      return;
    }
    if (newPassword.length < 6) {
      setStatus(passwordStatus, 'Password should be at least 6 characters.', false);
      return;
    }

    try {
      setStatus(passwordStatus, 'Updating password...', true);
      const res = await fetch('/api/account/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || json.message || 'Update failed');
      setStatus(passwordStatus, 'Password updated.', true);
      if (currentPasswordInput) currentPasswordInput.value = '';
      if (newPasswordInput) newPasswordInput.value = '';
      if (confirmPasswordInput) confirmPasswordInput.value = '';
    } catch (err) {
      console.error(err);
      setStatus(passwordStatus, err.message || 'Unable to update password.', false);
    }
  }

  async function loadAccounts() {
    if (!accountsCard || !accountsList) return;

    try {
      if (accountsStatus) accountsStatus.textContent = 'Loading accounts...';

      const res = await fetch('/api/account/users');
      if (res.status === 403) {
        // not admin
        hideAdminUI();
        cacheAdmin(false);
        return;
      }

      if (!res.ok) throw new Error('Failed to load users');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to load users');

      // clar admin
      showAdminUI();
      cacheAdmin(true);

      accountsCard.style.display = '';
      const users = Array.isArray(json.users) ? json.users : [];
      accountsList.innerHTML = '';
      if (!users.length) {
        accountsList.innerHTML = '<div class="status-line" data-inline="true">No additional accounts yet.</div>';
      } else {
        users.forEach(user => {
          const row = document.createElement('div');
          row.className = 'account-row';
          const identity = document.createElement('div');
          identity.className = 'identity';
          identity.innerHTML = `<strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.email || 'No email set')}</span>`;
          const actions = document.createElement('div');
          actions.className = 'settings-actions';
          if (user.username !== 'admin') {
            const del = document.createElement('button');
            del.className = 'btn danger';
            del.type = 'button';
            del.textContent = 'Delete';
            del.addEventListener('click', () => deleteAccount(user.username));
            actions.appendChild(del);
          } else {
            const badge = document.createElement('span');
            badge.className = 'status-line';
            badge.setAttribute('data-inline','true');
            badge.textContent = 'Owner';
            actions.appendChild(badge);
          }
          row.append(identity, actions);
          accountsList.appendChild(row);
        });
      }
      if (accountsStatus) accountsStatus.textContent = '';
    } catch (err) {
      console.error(err);
      if (accountsStatus) accountsStatus.textContent = 'Unable to load accounts.';
      showEdgeToast('Unable to load accounts.', false);
    }
  }

  async function deleteAccount(username) {
    if (!confirm(`Remove account "${username}"?`)) return;
    try {
      const res = await fetch(`/api/account/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json && json.success === false)) throw new Error(json.error || 'Delete failed');
      showEdgeToast('Account removed.', true);
      loadAccounts();
    } catch (err) {
      console.error(err);
      if (accountsStatus) accountsStatus.textContent = err.message || 'Unable to delete account.';
      showEdgeToast(err.message || 'Unable to delete account.', false);
    }
  }

  function openModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.add('open');
    modalEl.setAttribute('aria-hidden', 'false');
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.remove('open');
    modalEl.setAttribute('aria-hidden', 'true');
  }

  async function handleCreateAccount(e) {
    e.preventDefault();
    if (!createAccountForm || !createAccountStatus) return;

    const formData = new FormData(createAccountForm);
    const newUsername = (formData.get('newUsername') || '').toString().trim();
    const newEmail = (formData.get('newEmail') || '').toString().trim();
    const newPassword = (formData.get('newPassword') || '').toString();
    const confirmNewPassword = (formData.get('confirmNewPassword') || '').toString();

    if (!newUsername || !newEmail || !newPassword || !confirmNewPassword) {
      createAccountStatus.textContent = 'All fields are required.';
      createAccountStatus.style.color = 'var(--danger)';
      showEdgeToast('All fields are required.', false);
      return;
    }

    if (newPassword !== confirmNewPassword) {
      createAccountStatus.textContent = 'Passwords do not match.';
      createAccountStatus.style.color = 'var(--danger)';
      showEdgeToast('Passwords do not match.', false);
      return;
    }

    if (newPassword.length < 6) {
      createAccountStatus.textContent = 'Password must be at least 6 characters.';
      createAccountStatus.style.color = 'var(--danger)';
      showEdgeToast('Password must be at least 6 characters.', false);
      return;
    }

    createAccountStatus.textContent = 'Creating account...';
    createAccountStatus.style.color = 'var(--settings-muted)';
    showEdgeToast('Creating account...', true);

    try {
      const res = await fetch('/api/account/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newUsername,
          email: newEmail,
          password: newPassword
        })
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to create');
      createAccountStatus.textContent = 'Account created.';
      createAccountStatus.style.color = 'var(--settings-muted)';
      createAccountForm.reset();
      loadAccounts();
      showEdgeToast('Account created.', true);
    } catch (err) {
      console.error(err);
      createAccountStatus.textContent = err.message || 'Unable to create account.';
      createAccountStatus.style.color = 'var(--danger)';
      showEdgeToast(err.message || 'Unable to create account.', false);
    }
  }

  async function loadAccountProfile() {
    try {
      const res = await fetch('/api/account/me');
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success || !json.user) return;
      accountProfile = json.user;

      if (emailInput && accountProfile.email) emailInput.value = accountProfile.email;

      // fallback bg din server doar dacă n-aveai localStorage.bgPref
      const localRaw = localStorage.getItem('bgPref');
      if (!localRaw) {
        if (accountProfile.backgroundPreference) {
          saveLocalBackgroundPreference(accountProfile.backgroundPreference);
        } else {
          saveLocalBackgroundPreference(Object.assign({}, defaultBackground));
        }
      }

      // admin panel visibility + cache
      if (accountProfile.username === 'admin') {
        showAdminUI();
        cacheAdmin(true);
      } else {
        hideAdminUI();
        cacheAdmin(false);
      }
    } catch (err) {
      console.error(err);
    }
  }

  // ===== Registration Block (Yes=BLOCK, No=OPEN) =====
  function reflectRegisterUI(blocked) {
    if (!allowRegisterCard) return;
    currentRegisterBlocked = !!blocked;
    if (allowRegisterYes) allowRegisterYes.setAttribute('aria-pressed', blocked ? 'true' : 'false');
    if (allowRegisterNo) allowRegisterNo.setAttribute('aria-pressed', blocked ? 'false' : 'true');
    if (allowRegisterSegmented) allowRegisterSegmented.dataset.value = blocked ? 'yes' : 'no';
    if (registerStatus) {
      registerStatus.textContent = blocked
        ? 'Registration is blocked. /register returns 403 (direct /register.html is always blocked).'
        : 'Registration is open. /register serves register.html (direct /register.html is always blocked).';
    }
  }

  async function fetchRegisterBlocked() {
    try {
      const res = await fetch('/api/admin/register', { method: 'GET' });
      if (res.status === 403) {
        // not admin
        hideAdminUI();
        cacheAdmin(false);
        return null;
      }
      if (!res.ok) throw new Error('Failed to load registration setting');
      const json = await res.json();
      return !!(json && (json.blocked === true || json.blocked === 'true'));
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  async function setRegisterBlocked(blocked) {
    if (!allowRegisterCard) return;
    reflectRegisterUI(blocked); // optimistic
    try {
      const res = await fetch('/api/admin/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error(json.error || 'Request failed');
      reflectRegisterUI(!!json.blocked);
      showEdgeToast(blocked ? 'Registration blocked' : 'Registration opened', true);
    } catch (err) {
      console.error(err);
      reflectRegisterUI(!blocked); // revert
      showEdgeToast('Failed to update registration: ' + (err.message || err), false);
    }
  }

  async function initRegisterLock() {
    if (!allowRegisterCard) return;

    // dacă din cache știm sigur că nu e admin → nu mai facem nimic
    if (getCachedAdminFlag() === '0') {
      allowRegisterCard.style.display = 'none';
      return;
    }

    if (allowRegisterYes) allowRegisterYes.addEventListener('click', () => setRegisterBlocked(true));
    if (allowRegisterNo) allowRegisterNo.addEventListener('click', () => setRegisterBlocked(false));
    const serverVal = await fetchRegisterBlocked();
    if (serverVal === null) return; // ascuns deja dacă nu e admin
    reflectRegisterUI(serverVal);
  }
  // ===== END Registration Block =====

  // ----- Utilities -----
  function initDragDrop(dropEl, inputEl) {
    ['dragenter', 'dragover'].forEach(evt => dropEl.addEventListener(evt, e => {
      e.preventDefault();
      dropEl.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(evtName => dropEl.addEventListener(evtName, e => {
      e.preventDefault();
      dropEl.classList.remove('dragover');
    }));
    dropEl.addEventListener('drop', e => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        inputEl.files = e.dataTransfer.files;
        inputEl.dispatchEvent(new Event('change'));
      }
    });
    dropEl.addEventListener('click', () => inputEl.click());
    dropEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        inputEl.click();
      }
    });
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  async function handleLogout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
      console.error(err);
    }
    localStorage.removeItem('uploadToken');
    window.location.href = '/login';
  }
});
