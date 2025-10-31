document.addEventListener('DOMContentLoaded', () => {
  // Common bindings
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
  const imagesGrid = document.getElementById('imagesGrid');
  const galleryEmpty = document.getElementById('galleryEmpty');

  if (dropzone) initDragDrop(dropzone, fileInput);
  if (fileInput) fileInput.addEventListener('change', showPreview);
  if (uploadForm) uploadForm.addEventListener('submit', handleUpload);
  if (genBinary) genBinary.addEventListener('click', () => generateSxcu('binary'));
  if (genMultipart) genMultipart.addEventListener('click', () => generateSxcu('multipart'));

  if (imagesGrid) loadGallery();

  // Settings page bindings (preserve IDs)
  const settingsForm = document.getElementById('settingsForm');
  const saveSettings = document.getElementById('saveSettings');
  if (settingsForm) settingsForm.addEventListener('submit', handleSaveSettings);

  // Helper: retrieve stored upload token (if any)
  function getStoredToken(){
    return localStorage.getItem('uploadToken') || null;
  }
  function setStoredToken(t){
    if(t) localStorage.setItem('uploadToken', t);
    else localStorage.removeItem('uploadToken');
  }

  // ----- Dashboard functions -----
  async function handleUpload(e){
    e.preventDefault();
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file){
      showToast('Please select a file first');
      return;
    }

    const fd = new FormData();
    fd.append('file', file);

    const token = getStoredToken();

    try{
      showToast('Uploading...');
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
        body: fd
      });
      if(!res.ok) throw new Error(await res.text());
      const json = await res.json();
      showToast('Upload successful');
      // refresh gallery
      loadGallery();

    }catch(err){
      console.error(err);
      showToast('Upload failed: ' + (err.message || err));
    }
  }

  function showPreview(){
    const file = fileInput.files && fileInput.files[0];
    if(!file){ filePreview.innerHTML = ''; return; }
    const url = URL.createObjectURL(file);
    filePreview.innerHTML = `<img src="${url}" alt="preview" style="width:56px;height:56px;object-fit:cover;border-radius:8px">`;
  }

  async function generateSxcu(mode){
    // mode: 'binary' or 'multipart'
    const token = getStoredToken();
    try{
      showToast('Generating .sxcu...');
      const res = await fetch(`/api/generate-sxcu?type=${encodeURIComponent(mode)}`, {
        method: 'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if(!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const fileName = `sharex-${mode}.sxcu`;
      const url = URL.createObjectURL(blob);
      downloadLink.innerHTML = `<a class="btn outline" href="${url}" download="${fileName}">Download ${fileName}</a>`;
      showToast('.sxcu generated');
    }catch(err){
      console.error(err);
      showToast('Failed to generate .sxcu: ' + (err.message || err));
    }
  }

  async function loadGallery(){
    try{
      imagesGrid.innerHTML = '<div class="muted">Loading...</div>';
      const res = await fetch('/api/images');
      if(!res.ok) throw new Error('Failed to load images');
      const items = await res.json();
      if(!items || items.length === 0){
        imagesGrid.innerHTML = '';
        if(galleryEmpty) galleryEmpty.hidden = false;
        return;
      }
      if(galleryEmpty) galleryEmpty.hidden = true;
      imagesGrid.innerHTML = '';
      items.forEach(i => {
        const card = document.createElement('div');
        card.className = 'img-card';
        card.innerHTML = `<img src="${i.url}" alt="${i.name || 'upload'}"><div class="meta"><div class="meta-name">${escapeHtml(i.name || '')}</div><div><a class="link" href="${i.url}" target="_blank" rel="noopener">View</a></div></div>`;
        imagesGrid.appendChild(card);
      });
    }catch(err){
      console.error(err);
      imagesGrid.innerHTML = '<div class="muted">Failed to load gallery</div>';
    }
  }

  // ----- Settings functions -----
  async function handleSaveSettings(e){
    e.preventDefault();
    const email = document.getElementById('emailInput')?.value?.trim();
    const currentPassword = document.getElementById('currentPassword')?.value;
    const newPassword = document.getElementById('newPassword')?.value;
    const newUploadToken = document.getElementById('newUploadToken')?.value?.trim();

    const payload = { email, currentPassword, newPassword };
    if(newUploadToken) payload.newUploadToken = newUploadToken;

    try{
      const res = await fetch('/api/account/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if(!res.ok) throw new Error(json.message || 'Failed to save settings');
      // If backend returned a token, store it
      if(json.uploadToken) setStoredToken(json.uploadToken);
      else if(newUploadToken) setStoredToken(newUploadToken);
      const msgEl = document.getElementById('settingsMsg');
      if(msgEl) msgEl.textContent = 'Settings saved successfully';
    }catch(err){
      console.error(err);
      const msgEl = document.getElementById('settingsMsg');
      if(msgEl) msgEl.textContent = 'Failed to save settings: ' + (err.message || err);
    }
  }

  // ----- Utilities -----
  function initDragDrop(dropEl, inputEl){
    ['dragenter','dragover'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('dragover'); }));
    dropEl.addEventListener('drop', e => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if(file){
        inputEl.files = e.dataTransfer.files;
        inputEl.dispatchEvent(new Event('change'));
      }
    });
    dropEl.addEventListener('click', () => inputEl.click());
    dropEl.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' ') inputEl.click(); });
  }

  function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]); }

  function showToast(msg){
    // simple transient message in footer area
    let el = document.getElementById('sx-toast');
    if(!el){
      el = document.createElement('div'); el.id = 'sx-toast';
      el.style.position = 'fixed'; el.style.right = '20px'; el.style.bottom = '20px'; el.style.padding = '10px 14px'; el.style.borderRadius = '10px'; el.style.background = 'rgba(0,0,0,0.6)'; el.style.color = 'white'; el.style.zIndex = 9999; document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._h);
    el._h = setTimeout(()=> el.style.opacity = '0', 3500);
  }

  async function handleLogout(){
    try{
      await fetch('/api/logout', { method: 'POST' });
    }catch(e){ /* ignore */ }
    // clear local token
    setStoredToken(null);
    // redirect to login or root
    window.location.href = '/login' || '/';
  }

  // Pre-fill settings if on settings page
  (async function prefillSettings(){
    if(!document.getElementById('settingsForm')) return;
    try{
      const res = await fetch('/api/account/me');
      if(!res.ok) return;
      const json = await res.json();
      if(json.email) document.getElementById('emailInput').value = json.email;
    }catch(e){/* ignore */}
  })();

});
