document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  // Dashboard bindings
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

  if (dropzone && fileInput) initDragDrop(dropzone, fileInput);
  if (fileInput) fileInput.addEventListener('change', () => showPreview(fileInput, filePreview));
  if (uploadForm) uploadForm.addEventListener('submit', e => handleUpload(e, fileInput));
  if (genBinary) genBinary.addEventListener('click', () => generateSxcu('binary', downloadLink));
  if (genMultipart) genMultipart.addEventListener('click', () => generateSxcu('multipart', downloadLink));
  if (imagesGrid) loadGallery(imagesGrid, galleryEmpty);

  // Settings bindings
  const settingsMenuToggle = document.getElementById('settingsMenuToggle');
  const settingsMenuClose = document.getElementById('settingsMenuClose');
  const settingsNav = document.getElementById('settingsNav');
  const settingsNavBackdrop = document.getElementById('settingsNavBackdrop');
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
    const media = window.matchMedia('(min-width: 1024px)');
    const openNav = () => {
      settingsNav.classList.add('is-open');
      settingsNavBackdrop?.classList.add('visible');
      settingsNavBackdrop?.removeAttribute('hidden');
    };

    const closeNav = (force = false) => {
      if (media.matches && !force) return;
      if (!settingsNav.classList.contains('is-open') && !media.matches) return;
      settingsNav.classList.remove('is-open');
      settingsNavBackdrop?.classList.remove('visible');
      settingsNavBackdrop?.setAttribute('hidden', 'hidden');
    };

    const syncDesktopState = () => {
      if (media.matches) {
        settingsNav.classList.add('is-open');
        settingsNavBackdrop?.classList.remove('visible');
        settingsNavBackdrop?.setAttribute('hidden', 'hidden');
      }
    };
    syncDesktopState();
    media.addEventListener('change', syncDesktopState);

    settingsMenuToggle?.addEventListener('click', () => {
      if (settingsNav.classList.contains('is-open') && media.matches) return;
      if (settingsNav.classList.contains('is-open')) closeNav();
      else openNav();
    });
    settingsMenuClose?.addEventListener('click', () => closeNav(true));
    settingsNavBackdrop?.addEventListener('click', () => closeNav(true));

    document.addEventListener('keydown', evt => {
      if (evt.key === 'Escape') {
        closeNav(true);
        if (createAccountModal?.classList.contains('open')) closeModal(createAccountModal);
      }
    });

    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.panelTarget;
        if (!target) return;
        switchSettingsPanel(target);
        if (!window.matchMedia('(min-width: 1024px)').matches) {
          closeNav();
        }
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

  const preferencesCard = document.getElementById('preferencesCard');
  const backgroundColorInput = document.getElementById('backgroundColor');
  const backgroundHexInput = document.getElementById('backgroundColorHex');
  const applyColorBtn = document.getElementById('applyColor');
  const backgroundUploadInput = document.getElementById('backgroundUpload');
  const backgroundUploadBtn = document.getElementById('uploadBackground');
  const backgroundTemplates = document.getElementById('backgroundTemplates');
  const preferencesStatus = document.getElementById('preferencesStatus');
  const resetBackgroundBtn = document.getElementById('resetBackground');

  const accountBasicsForm = document.getElementById('accountBasicsForm');
  const accountBasicsStatus = document.getElementById('accountBasicsStatus');
  const emailInput = document.getElementById('emailInput');
  const newUploadTokenInput = document.getElementById('newUploadToken');
  const currentPasswordBasics = document.getElementById('currentPasswordBasics');

  const passwordForm = document.getElementById('passwordForm');
  const currentPasswordInput = document.getElementById('currentPassword');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmPasswordInput = document.getElementById('confirmPassword');
  const passwordStatus = document.getElementById('passwordStatus');

  const accountsCard = document.getElementById('accountsCard');
  const accountsList = document.getElementById('accountsList');
  const accountsStatus = document.getElementById('accountsStatus');
  const openCreateAccount = document.getElementById('openCreateAccount');
  const createAccountForm = document.getElementById('createAccountForm');
  const createAccountStatus = document.getElementById('createAccountStatus');

  const modalCloseButtons = document.querySelectorAll('[data-close-modal]');

  let templatesList = [];
  let defaultBackground = { type: 'color', value: '#05080f' };
  let currentBackground = null;
  let accountProfile = null;

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
        saveBackgroundPreference({ type: 'color', value: candidate });
      });
    }
    if (backgroundUploadBtn) {
      backgroundUploadBtn.addEventListener('click', () => handleBackgroundUpload(backgroundUploadInput));
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
      resetBackgroundBtn.addEventListener('click', () => saveBackgroundPreference(Object.assign({}, defaultBackground)));
    }
  }

  if (backgroundFileName) {
    updateBackgroundFilename();
  }

  if (accountBasicsForm) {
    accountBasicsForm.addEventListener('submit', e => handleBasicsSubmit(e));
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', e => handlePasswordChange(e));
  }

  if (openCreateAccount && createAccountModal && createAccountForm) {
    openCreateAccount.addEventListener('click', () => openModal(createAccountModal));
    modalCloseButtons.forEach(btn => btn.addEventListener('click', () => closeModal(createAccountModal)));
    createAccountModal.addEventListener('click', evt => { if (evt.target === createAccountModal) closeModal(createAccountModal); });
    createAccountForm.addEventListener('submit', e => handleCreateAccount(e));
  }

  loadBackgroundOptions();
  loadAccountProfile();
  if (accountsCard) loadAccounts();

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
      showToast('Please choose a file first.');
      return;
    }

    const fd = new FormData();
    fd.append('file', file);

    const token = getStoredToken();

    try {
      showToast('Uploading...');
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: fd
      });
      if (!res.ok) throw new Error(await res.text());
      await res.json();
      showToast('Upload successful');
      if (imagesGrid) loadGallery(imagesGrid, galleryEmpty);
      if (filePreview) filePreview.innerHTML = '';
      if (inputEl) inputEl.value = '';
    } catch (err) {
      console.error(err);
      showToast('Upload failed: ' + (err.message || err));
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
      showToast('Generating .sxcu...');
      const res = await fetch(`/api/generate-sxcu?mode=${encodeURIComponent(mode)}`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const fileName = `sharex-${mode}.sxcu`;
      if (outputEl) {
        outputEl.innerHTML = `<a class="btn subtle" href="${url}" download="${fileName}">Download ${fileName}</a>`;
      }
      showToast('.sxcu generated');
    } catch (err) {
      console.error(err);
      showToast('Failed to generate .sxcu: ' + (err.message || err));
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

  // ----- Settings logic -----
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

  function setStatus(el, message, ok = true) {
    if (!el) return;
    el.textContent = message || '';
    el.style.color = ok ? 'var(--settings-muted)' : 'var(--danger)';
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
      if (!currentBackground) reflectBackground(Object.assign({}, defaultBackground));
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
      if (currentBackground && currentBackground.type === 'template' && currentBackground.value === url) {
        button.classList.add('active');
      }
      button.addEventListener('click', () => saveBackgroundPreference({ type: 'template', value: url }));
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

  function updateBackgroundFilename() {
    if (!backgroundFileName) return;
    const file = backgroundUploadInput && backgroundUploadInput.files && backgroundUploadInput.files[0];
    backgroundFileName.textContent = file ? file.name : 'No file selected';
    if (backgroundUploadLabel) {
      backgroundUploadLabel.classList.toggle('has-file', Boolean(file));
    }
  }

  async function saveBackgroundPreference(preference) {
    if (!preference) return;
    setStatus(preferencesStatus, 'Saving background...', true);
    try {
      const res = await fetch('/api/account/background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference })
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || json.message || 'Failed to save');
      reflectBackground(json.backgroundPreference);
      setStatus(preferencesStatus, 'Background updated.', true);
    } catch (err) {
      console.error(err);
      setStatus(preferencesStatus, err.message || 'Failed to save background.', false);
    }
  }

  async function handleBackgroundUpload(inputEl) {
    if (!inputEl || !inputEl.files || !inputEl.files[0]) {
      setStatus(preferencesStatus, 'Choose an image to upload.', false);
      return;
    }
    const fd = new FormData();
    fd.append('background', inputEl.files[0]);
    setStatus(preferencesStatus, 'Uploading background...', true);
    try {
      const res = await fetch('/api/account/background/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || json.message || 'Upload failed');
      reflectBackground(json.backgroundPreference);
      setStatus(preferencesStatus, 'Custom background applied.', true);
      inputEl.value = '';
      updateBackgroundFilename();
    } catch (err) {
      console.error(err);
      setStatus(preferencesStatus, err.message || 'Upload failed.', false);
    }
  }

  function reflectBackground(pref) {
    if (!pref) return;
    currentBackground = pref;
    applyBackground(pref);
    if (pref.type === 'color') syncColorInputs(pref.value);
    markTemplate(pref.type === 'template' ? pref.value : null);
  }

  function applyBackground(pref) {
    const root = document.body;
    if (!root || !pref) return;
    root.dataset.bgType = pref.type || 'color';
    if (pref.type === 'color') {
      root.style.backgroundImage = 'none';
      root.style.backgroundColor = pref.value;
      root.style.setProperty('--settings-bg', pref.value);
      root.style.removeProperty('background-size');
      root.style.removeProperty('background-repeat');
      root.style.removeProperty('background-position');
      root.style.removeProperty('background-attachment');
    } else {
      root.style.backgroundImage = `url('${pref.value}')`;
      root.style.backgroundColor = '#040814';
      root.style.backgroundSize = 'cover';
      root.style.backgroundRepeat = 'no-repeat';
      root.style.backgroundPosition = 'center';
      root.style.backgroundAttachment = 'fixed';
      root.style.removeProperty('--settings-bg');
    }
  }

  async function handleBasicsSubmit(event) {
    event.preventDefault();
    if (!accountBasicsStatus) return;
    const email = emailInput?.value?.trim();
    const newUploadToken = newUploadTokenInput?.value?.trim();
    const currentPassword = currentPasswordBasics?.value || '';

    if (!email && !newUploadToken) {
      setStatus(accountBasicsStatus, 'Nothing to update yet.', false);
      return;
    }
    if (newUploadToken && !currentPassword) {
      setStatus(accountBasicsStatus, 'Current password required to change the upload token.', false);
      return;
    }

    const payload = {};
    if (email) payload.email = email;
    if (newUploadToken) payload.newUploadToken = newUploadToken;
    if (currentPassword) payload.currentPassword = currentPassword;

    try {
      setStatus(accountBasicsStatus, 'Saving changes...', true);
      const res = await fetch('/api/account/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || json.message || 'Save failed');
      setStatus(accountBasicsStatus, 'Account settings updated.', true);
      if (email && accountProfile) accountProfile.email = email;
      if (newUploadToken) setStoredToken(newUploadToken);
      if (newUploadTokenInput) newUploadTokenInput.value = '';
      if (currentPasswordBasics) currentPasswordBasics.value = '';
    } catch (err) {
      console.error(err);
      setStatus(accountBasicsStatus, err.message || 'Unable to save settings.', false);
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
      accountsStatus && (accountsStatus.textContent = 'Loading accounts...');
      const res = await fetch('/api/account/users');
      if (res.status === 403) {
        accountsCard.style.display = 'none';
        const adminNavBtn = settingsNav?.querySelector('[data-panel-target="admin"]');
        const adminPanel = document.querySelector('[data-settings-panel="admin"]');
        adminNavBtn?.setAttribute('hidden', 'hidden');
        adminNavBtn?.classList.remove('active');
        adminPanel?.setAttribute('hidden', 'hidden');
        adminPanel?.classList.remove('is-active');
        if (activePanel === 'admin') switchSettingsPanel('preferences');
        return;
      }
      if (!res.ok) throw new Error('Failed to load users');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to load users');
      accountsCard.style.display = '';
      const users = Array.isArray(json.users) ? json.users : [];
      accountsList.innerHTML = '';
      if (!users.length) {
        accountsList.innerHTML = '<div class="status-line">No additional accounts yet.</div>';
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
    }
  }

  async function deleteAccount(username) {
    if (!confirm(`Remove account "${username}"?`)) return;
    try {
      const res = await fetch(`/api/account/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json && json.success === false)) throw new Error(json.error || 'Delete failed');
      loadAccounts();
    } catch (err) {
      console.error(err);
      if (accountsStatus) accountsStatus.textContent = err.message || 'Unable to delete account.';
    }
  }

  async function handleCreateAccount(event) {
    event.preventDefault();
    if (!createAccountStatus) return;
    const username = document.getElementById('createUsername')?.value?.trim();
    const email = document.getElementById('createEmail')?.value?.trim();
    const password = document.getElementById('createPassword')?.value || '';
    const confirm = document.getElementById('createPasswordConfirm')?.value || '';

    if (!username || !email || !password) {
      setStatus(createAccountStatus, 'All fields are required.', false);
      return;
    }
    if (password !== confirm) {
      setStatus(createAccountStatus, 'Passwords do not match.', false);
      return;
    }
    if (password.length < 6) {
      setStatus(createAccountStatus, 'Password must be at least 6 characters.', false);
      return;
    }

    try {
      setStatus(createAccountStatus, 'Creating account...', true);
      const res = await fetch('/api/account/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newUsername: username, email, password })
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || json.message || 'Create failed');
      setStatus(createAccountStatus, 'Account created.', true);
      loadAccounts();
      setTimeout(() => {
        closeModal(createAccountModal);
        createAccountForm?.reset();
        setStatus(createAccountStatus, '');
      }, 300);
    } catch (err) {
      console.error(err);
      setStatus(createAccountStatus, err.message || 'Unable to create account.', false);
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

  async function loadAccountProfile() {
    try {
      const res = await fetch('/api/account/me');
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success || !json.user) return;
      accountProfile = json.user;
      if (emailInput && accountProfile.email) emailInput.value = accountProfile.email;
      if (accountProfile.backgroundPreference) {
        reflectBackground(accountProfile.backgroundPreference);
      } else {
        reflectBackground(Object.assign({}, defaultBackground));
      }
      if (settingsNav) {
        const adminNavBtn = settingsNav.querySelector('[data-panel-target="admin"]');
        const adminPanel = document.querySelector('[data-settings-panel="admin"]');
        if (adminNavBtn && adminPanel) {
          if (accountProfile.username === 'admin') {
            adminNavBtn.removeAttribute('hidden');
            adminPanel.removeAttribute('hidden');
          } else {
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
    } catch (err) {
      console.error(err);
    }
  }

  // ----- Utilities -----
  function initDragDrop(dropEl, inputEl) {
    ['dragenter', 'dragover'].forEach(evt => dropEl.addEventListener(evt, e => {
      e.preventDefault();
      dropEl.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(evt => dropEl.addEventListener(evt, e => {
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
    return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function showToast(message) {
    let el = document.getElementById('sx-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sx-toast';
      el.style.position = 'fixed';
      el.style.right = '20px';
      el.style.bottom = '20px';
      el.style.padding = '10px 14px';
      el.style.borderRadius = '12px';
      el.style.background = 'rgba(0,0,0,0.7)';
      el.style.color = '#fff';
      el.style.zIndex = 9999;
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.opacity = '1';
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => { el.style.opacity = '0'; }, 3500);
  }

  async function handleLogout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
      console.error(err);
    }
    setStoredToken(null);
    window.location.href = '/login';
  }
});
