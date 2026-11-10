/* Shared saving for the ring pages.
   Saved specs live in the GitHub repo as <ring>/spec.json.
   Writing needs a GitHub token, stored in save-config.json encrypted with the save password
   (PBKDF2 + AES-GCM). The token is only ever decrypted in the browser and sent only to GitHub. */
(function(){
  const OWNER = 'kadakiaamay02', REPO = 'rings', BRANCH = 'main', CONFIG = 'save-config.json';
  const me = document.currentScript;
  const ROOT = new URL('.', me.src);                       // site root, e.g. https://kadakiaamay02.github.io/rings/
  const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // Read a JSON file from the repo: GitHub API first (freshest), then the Pages copy.
  async function readPublic(path){
    try{
      const r = await fetch(API + path + '?ref=' + BRANCH, {headers:{Accept:'application/vnd.github.raw+json'}, cache:'no-store'});
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    }catch(e){}
    try{
      const r = await fetch(new URL(path, ROOT).href + '?t=' + Date.now(), {cache:'no-store'});
      if (r.ok) return await r.json();
    }catch(e){}
    return null;
  }

  async function deriveKey(pw, salt, iter){
    const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:iter, hash:'SHA-256'}, base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
  }
  async function encryptToken(token, pw){
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 600000;
    const key = await deriveKey(pw, salt, iter);
    const data = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, enc.encode(token)));
    return {v:1, iter, salt:b64(salt), iv:b64(iv), data:b64(data)};
  }
  async function unlock(pw){
    const cfg = await readPublic(CONFIG);
    if (!cfg || !cfg.data) throw {code:'no_config'};
    const key = await deriveKey(pw, unb64(cfg.salt), cfg.iter);
    try{ return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(cfg.iv)}, key, unb64(cfg.data))); }
    catch(e){ throw {code:'bad_pw'}; }
  }

  async function putFile(token, path, text, message){
    const h = {Authorization:'Bearer ' + token, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'};
    for (let attempt = 0; attempt < 2; attempt++){
      let sha;
      const g = await fetch(API + path + '?ref=' + BRANCH, {headers:h, cache:'no-store'});
      if (g.ok) sha = (await g.json()).sha;
      else if (g.status !== 404) throw {code:'http', status:g.status};
      const body = {message, content:b64(enc.encode(text)), branch:BRANCH};
      if (sha) body.sha = sha;
      const p = await fetch(API + path, {method:'PUT', headers:h, body:JSON.stringify(body)});
      if (p.ok) return;
      if (p.status !== 409 || attempt) throw {code:'http', status:p.status};
    }
  }

  function explain(err){
    if (!err) return 'Saving failed. Try again in a moment.';
    if (err.code === 'bad_pw') return 'Wrong password.';
    if (err.code === 'no_config') return 'Saving is not set up yet. Open setup.html on this site to turn it on.';
    if (err.code === 'http' && err.status === 401) return 'The GitHub key has expired or was revoked. Run setup.html again with a new key.';
    if (err.code === 'http' && (err.status === 403 || err.status === 404)) return 'The GitHub key cannot write to the rings repo. Check that it has Contents: Read and write for this repo.';
    if (err.code === 'http' && err.status === 422) return 'GitHub rejected the save. Try again.';
    return 'Saving failed. Check your connection and try again.';
  }

  window.RingSave = {OWNER, REPO, BRANCH, CONFIG, encryptToken, putFile, readPublic, explain};

  /* ---------- STL export (binary, millimeters) ---------- */
  // Kinds: engraving meshes carry an alphaMap (texture only, no geometry); gems use a shader or a non-metal material.
  const isEngraving = o => !!(o.material && o.material.alphaMap);
  const isGem = o => !!(o.material && (o.material.isShaderMaterial || o.material.metalness === 0));
  function buildSTL(root, withStones){
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || isEngraving(o)) return;
      if (!withStones && isGem(o)) return;
      meshes.push(o);
    });
    let count = 0;
    meshes.forEach(o => { const g = o.geometry; count += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3); });
    const buf = new ArrayBuffer(84 + count * 50), dv = new DataView(buf);
    const head = 'Ring export, units: mm';
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, count, true);
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), E = new THREE.Vector3();
    let off = 84;
    const put = v => { dv.setFloat32(off, v.x, true); dv.setFloat32(off + 4, v.y, true); dv.setFloat32(off + 8, v.z, true); off += 12; };
    meshes.forEach(o => {
      const g = o.geometry, p = g.attributes.position, idx = g.index, m = o.matrixWorld;
      const flip = m.determinant() < 0, n = idx ? idx.count : p.count;
      for (let i = 0; i + 2 < n; i += 3){
        let a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
        if (flip){ const t = b; b = c; c = t; }
        A.fromBufferAttribute(p, a).applyMatrix4(m); B.fromBufferAttribute(p, b).applyMatrix4(m); C.fromBufferAttribute(p, c).applyMatrix4(m);
        N.subVectors(C, B).cross(E.subVectors(A, B)).normalize();
        put(N); put(A); put(B); put(C); dv.setUint16(off, 0, true); off += 2;
      }
    });
    return new Blob([buf], {type:'model/stl'});
  }
  function saveBlob(blob, name){
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------- Ring page wiring ---------- */
  const SPEC = me.dataset.spec;
  if (!SPEC) return;
  const NAME = me.dataset.name || 'ring';

  // Load the saved design for everyone.
  readPublic(SPEC).then(s => { if (s && typeof s === 'object' && window.__applyState) window.__applyState(s); });

  const reset = document.getElementById('reset');
  if (!reset || !window.__getState) return;
  const css = document.createElement('style');
  css.textContent = '.save-box{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}'
    + '.save-box input{flex:1 1 140px;min-width:0;font:inherit;font-size:14px;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:inherit}'
    + '.save-msg{font-size:12.5px;color:var(--muted);margin-top:6px;min-height:1.2em}';
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = reset.className; btn.id = 'save-design'; btn.textContent = 'Save design';
  reset.after(btn);
  const box = document.createElement('form');
  box.className = 'save-box'; box.hidden = true; box.setAttribute('aria-label', 'Save design');
  box.innerHTML = '<input type="password" id="save-pw" placeholder="Password" autocomplete="off" inputmode="numeric" aria-label="Password">'
    + '<button type="submit" class="' + reset.className + '">Save for everyone</button>'
    + '<button type="button" class="' + reset.className + '" id="save-cancel">Cancel</button>';
  const msg = document.createElement('div'); msg.className = 'save-msg'; msg.setAttribute('role', 'status');
  reset.parentElement.after(box); box.after(msg);
  const pw = box.querySelector('#save-pw'), submit = box.querySelector('[type=submit]');
  const say = t => { msg.textContent = t; };

  // STL buttons
  const stl = document.createElement('div');
  stl.className = 'save-box'; stl.setAttribute('aria-label', 'Download 3D file');
  stl.innerHTML = '<span class="stl-lbl">3D file (STL, mm)</span>'
    + '<button type="button" class="' + reset.className + '" id="stl-metal">Metal only</button>'
    + '<button type="button" class="' + reset.className + '" id="stl-full">With stones</button>';
  msg.after(stl);
  css.textContent += '.stl-lbl{font-size:12.5px;color:var(--muted);flex-basis:100%}';
  const exportSTL = withStones => {
    const root = window.__ringObject && window.__ringObject();
    if (!root || !window.THREE){ say('The 3D view is not running in this browser, so there is nothing to export.'); return; }
    try{
      saveBlob(buildSTL(root, withStones), NAME + (withStones ? '-with-stones' : '-metal') + '.stl');
      say(withStones ? 'Downloaded the ring with stones as STL.' : 'Downloaded the metal as STL.');
    }catch(e){ say('Could not build the STL file.'); }
  };
  stl.querySelector('#stl-metal').addEventListener('click', () => exportSTL(false));
  stl.querySelector('#stl-full').addEventListener('click', () => exportSTL(true));

  btn.addEventListener('click', () => { box.hidden = false; say(''); pw.focus(); });
  box.querySelector('#save-cancel').addEventListener('click', () => { box.hidden = true; pw.value = ''; say(''); });
  box.addEventListener('submit', async e => {
    e.preventDefault();
    if (!window.crypto || !crypto.subtle){ say('This browser cannot check the password.'); return; }
    submit.disabled = true; say('Checking password…');
    try{
      const token = await unlock(pw.value.trim());
      say('Saving…');
      const text = JSON.stringify(window.__getState(), null, 2) + '\n';
      await putFile(token, SPEC, text, 'Save ' + SPEC.split('/')[0] + ' ring design');
      pw.value = ''; box.hidden = true;
      say('Saved. Everyone who opens this page now sees this design.');
    }catch(err){
      say(explain(err));
      if (err && err.code === 'bad_pw') pw.select();
    }finally{ submit.disabled = false; }
  });
})();
