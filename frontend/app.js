// app.js — full, clean, and improved (modal + inline popup button fixes)
const API_BASE = window.API_BASE || "http://localhost:3000";
console.log("API_BASE =", API_BASE);

// Initialize map
const map = L.map("map").setView([-6.2, 106.816666], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

/* ---------------- cluster group (custom) -------------- */
let clusteringEnabled = true;
const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 120,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  animate: true,
  iconCreateFunction(cluster) {
    const count = cluster.getChildCount();
    let size = 40;
    if (count > 50) size = 60;
    else if (count > 10) size = 48;
    const html = `<div style="
      width:${size}px;height:${size}px;background:linear-gradient(180deg,#1E88E5,#1976d2);
      color:white;border-radius:999px;display:flex;align-items:center;justify-content:center;
      box-shadow:0 6px 18px rgba(11,22,36,0.18);font-weight:700;font-size:14px;">${count}</div>`;
    return L.divIcon({ html, className: "custom-cluster-icon", iconSize: L.point(size, size) });
  },
});

/* ---------------- server layer & drawn items -------------- */
const serverLayer = L.geoJSON(null, {
  pointToLayer: (feature, latlng) => L.marker(latlng),
  onEachFeature(feature, layer) {
    const props = feature.properties || {};
    const id = props.id;
    const name = props.name || "Unnamed";
    const desc = props.description || "";
    const html = `
      <div style="min-width:200px">
        <b>${escapeHtml(name)}</b>
        <div style="margin-top:8px;color:#4b5563">${escapeHtml(desc)}</div>
        <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn-inline-edit" data-id="${id}">Edit</button>
          <button class="btn-inline-delete" data-id="${id}">Delete</button>
        </div>
      </div>`;
    layer.bindPopup(html, { maxWidth: 300 });

    layer.on("popupopen", (e) => {
      setTimeout(() => {
        const node = e.popup._contentNode;
        if (!node) return;
        const ed = node.querySelector(".btn-inline-edit");
        const del = node.querySelector(".btn-inline-delete");
        if (ed) ed.addEventListener("click", (ev) => { ev.stopPropagation(); openInlineEdit(id, layer); });
        if (del) del.addEventListener("click", (ev) => { ev.stopPropagation(); if (confirm("Hapus feature?")) deleteFeature(id); });
      }, 0);
    });

    layer.on("click", () => {
      highlightPreviewItem(id);
      setTimeout(() => { try { layer.openPopup(); } catch(e) {} }, 10);
    });

    layer._featureId = id;
  },
});

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// Add server to map respecting clustering option
function addServerToMap() {
  if (clusteringEnabled) {
    clusterGroup.clearLayers();
    serverLayer.eachLayer((l) => clusterGroup.addLayer(l));
    if (!map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
    if (map.hasLayer(serverLayer)) map.removeLayer(serverLayer);
  } else {
    if (!map.hasLayer(serverLayer)) map.addLayer(serverLayer);
    if (map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
  }
}

/* ------------- draw controls ------------- */
const drawControl = new L.Control.Draw({
  edit: { featureGroup: drawnItems, edit: true, remove: true },
  draw: { polygon: true, polyline: true, rectangle: true, marker: true, circle: false, circlemarker: false },
});
map.addControl(drawControl);

/* ------------- helpers ------------- */
const layerToServerId = new Map();

function showToast(msg, t = 2500) {
  const c = document.getElementById("toast");
  if (!c) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerText = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), t);
}

function showSpinner(on = true) {
  const s = document.getElementById("spinnerOverlay");
  if (!s) return;
  s.style.display = on ? "flex" : "none";
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
}

/* ================= SAFE fetch for bbox ================= */
async function fetchFeaturesBBox() {
  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  try {
    const res = await fetch(`${API_BASE}/features?bbox=${encodeURIComponent(bbox)}`, { cache: "no-store" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${txt ? ': ' + txt : ''}`);
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return { type: "FeatureCollection", features: [] };
    if (!Array.isArray(json.features)) json.features = [];
    return json;
  } catch (err) {
    throw new Error(err && err.message ? err.message : "Network error");
  }
}

/* ================ Render & update preview ================ */
let lastLoadError = null;
let latestFC = { type: "FeatureCollection", features: [] };
let currentHighlightedId = null;

async function renderServerFeaturesBBox() {
  try {
    showSpinner(true);
    const fc = await fetchFeaturesBBox();
    latestFC = fc || { type: "FeatureCollection", features: [] };

    if (!latestFC || latestFC.type !== "FeatureCollection" || !Array.isArray(latestFC.features)) {
      serverLayer.clearLayers();
      clusterGroup.clearLayers();
      document.getElementById("data-count").innerText = `0 features in view`;
      await syncServerToDrawn();
      updatePreviewList([]);
      return;
    }

    serverLayer.clearLayers();
    serverLayer.addData(latestFC);
    addServerToMap();

    const count = latestFC.features.length;
    document.getElementById("data-count").innerText = `${count} features in view`;

    await syncServerToDrawn();
    updatePreviewList(latestFC.features);

    if (currentHighlightedId) {
      const still = latestFC.features.find(f => f.properties && f.properties.id === currentHighlightedId);
      if (!still) clearHighlight();
    }

    lastLoadError = null;
  } catch (err) {
    console.error("renderServerFeaturesBBox error:", err);
    const msg = "Load error: " + (err && err.message ? err.message : "Unknown");
    if (msg !== lastLoadError) { showToast(msg, 4000); lastLoadError = msg; }
  } finally {
    showSpinner(false);
  }
}

map.on("moveend", debounce(renderServerFeaturesBBox, 400));
map.whenReady(() => renderServerFeaturesBBox());

/* -------------- DRAW EVENTS -------------- */
map.on(L.Draw.Event.CREATED, async (e) => {
  const layer = e.layer;
  const out = await promptNameDesc();
  if (!out) return;
  const geo = layer.toGeoJSON().geometry;

  try {
    showSpinner(true);
    const r = await fetch(`${API_BASE}/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: out.name, description: out.description, geojson: geo })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? ': ' + txt : ''}`);
    }
    const j = await r.json().catch(() => null);
    const sid = j && j.id ? j.id : null;
    drawnItems.addLayer(layer);
    if (sid) { layerToServerId.set(layer._leaflet_id, sid); layer._featureId = sid; }
    showToast("Saved");
    await renderServerFeaturesBBox();
  } catch (err) {
    console.error(err);
    showToast("Save error: " + err.message, 3500);
  } finally {
    showSpinner(false);
  }
});

map.on(L.Draw.Event.EDITED, async (e) => {
  const layers = e.layers;
  const updates = [];
  layers.eachLayer((l) => {
    const sid = layerToServerId.get(l._leaflet_id) || l._featureId;
    if (sid) updates.push({ sid, geo: l.toGeoJSON().geometry });
  });
  if (updates.length === 0) { showToast("No server-backed features edited"); return; }

  try {
    showSpinner(true);
    for (const u of updates) {
      const res = await fetch(`${API_BASE}/features/${u.sid}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geojson: u.geo })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}${txt ? ': ' + txt : ''}`);
      }
    }
    showToast("Updated");
    await renderServerFeaturesBBox();
  } catch (err) {
    console.error(err);
    showToast("Update error: " + err.message, 3500);
  } finally {
    showSpinner(false);
  }
});

map.on(L.Draw.Event.DELETED, async (e) => {
  const layers = e.layers;
  const dels = [];
  layers.eachLayer((l) => {
    const sid = layerToServerId.get(l._leaflet_id) || l._featureId;
    if (sid) dels.push(sid);
  });
  if (dels.length === 0) { showToast("No server-backed features removed"); return; }

  try {
    showSpinner(true);
    for (const id of dels) {
      const r = await fetch(`${API_BASE}/features/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? ': ' + txt : ''}`);
      }
    }
    showToast("Deleted");
    await renderServerFeaturesBBox();
  } catch (err) {
    console.error(err);
    showToast("Delete error: " + err.message, 3500);
  } finally {
    showSpinner(false);
  }
});

/* ---------------- server ops ---------------- */
async function deleteFeature(id) {
  try {
    showSpinner(true);
    const r = await fetch(`${API_BASE}/features/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? ': ' + txt : ''}`);
    }
    showToast("Deleted");
    if (currentHighlightedId === id) clearHighlight();
    await renderServerFeaturesBBox();
  } catch (err) {
    console.error(err);
    showToast("Delete error: " + err.message);
  } finally {
    showSpinner(false);
  }
}

/* -------------- Inline edit popup -------------- */
function openInlineEdit(id, layer) {
  const props = layer.feature ? (layer.feature.properties || {}) : {};
  const curName = props.name || "", curDesc = props.description || "";
  const html = `<form id="inline-edit" style="min-width:220px">
    <input name="name" value="${escapeHtml(curName)}" placeholder="Name" style="width:100%;padding:6px;margin-bottom:6px"/>
    <textarea name="description" placeholder="Description" style="width:100%;padding:6px">${escapeHtml(curDesc)}</textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button type="button" id="cancel-inline" class="btn-inline-secondary">Cancel</button>
      <button type="submit" class="btn-inline-action">Save</button>
    </div>
  </form>`;
  layer.setPopupContent(html).openPopup();
  setTimeout(() => {
    const cancelBtn = document.getElementById("cancel-inline");
    const inlineForm = document.getElementById("inline-edit");
    if (cancelBtn) cancelBtn.onclick = () => layer.openPopup();
    if (inlineForm) inlineForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const name = fd.get("name");
      const description = fd.get("description");
      if (!name || String(name).trim() === '') { alert("Name wajib"); return; }
      try {
        showSpinner(true);
        const res = await fetch(`${API_BASE}/features/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description })
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText}${txt ? ': ' + txt : ''}`);
        }
        showToast("Updated");
        await renderServerFeaturesBBox();
      } catch (err) {
        console.error(err);
        showToast("Update error: " + err.message);
      } finally {
        showSpinner(false);
      }
    };
  }, 0);
}

/* ---------------- Modal prompt for create (improved) ---------------- */
function promptNameDesc(prefillName = "", prefillDesc = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const box = document.createElement("div");
    box.className = "modal-box";

    box.innerHTML = `
      <div class="modal-title">Isi informasi</div>
      <form id="modal-form" autocomplete="off">
        <input id="modal-name" name="name" type="text" placeholder="Name" value="${escapeHtml(prefillName)}" />
        <textarea id="modal-desc" name="description" placeholder="Description">${escapeHtml(prefillDesc)}</textarea>
        <div class="modal-actions">
          <button type="button" id="modal-cancel" class="btn secondary">Cancel</button>
          <button type="submit" id="modal-save" class="btn">Save</button>
        </div>
      </form>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const form = document.getElementById("modal-form");
    const nameInput = document.getElementById("modal-name");
    const descInput = document.getElementById("modal-desc");
    const cancelBtn = document.getElementById("modal-cancel");

    setTimeout(() => { nameInput && nameInput.focus(); }, 60);

    cancelBtn.onclick = () => {
      overlay.remove();
      resolve(null);
    };

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const name = (nameInput.value || "").trim();
      const description = (descInput.value || "").trim();
      if (!name) {
        nameInput.focus();
        nameInput.style.borderColor = "#ef4444";
        setTimeout(() => nameInput.style.borderColor = "#e3e8ef", 1200);
        return;
      }
      overlay.remove();
      resolve({ name, description });
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        overlay.remove();
        resolve(null);
      }
    };
    document.addEventListener("keydown", onKey, { once: true });
  });
}

/* ------------- sync server -> drawnItems -------------- */
async function syncServerToDrawn() {
  drawnItems.clearLayers();
  layerToServerId.clear();
  serverLayer.eachLayer((l) => {
    const feat = l.feature;
    if (!feat) return;
    const newLayer = L.geoJSON(feat).getLayers()[0];
    if (!newLayer) return;
    drawnItems.addLayer(newLayer);
    const sid = feat.properties && feat.properties.id;
    if (sid) {
      layerToServerId.set(newLayer._leaflet_id, sid);
      newLayer._featureId = sid;
    }
  });
}

/* ------------- Data Preview: update list & search -------------- */
const previewListEl = document.getElementById("preview-list");
const previewSearchEl = document.getElementById("preview-search");

function updatePreviewList(features) {
  const arr = Array.isArray(features) ? features.slice() : [];
  latestFC = { type: "FeatureCollection", features: arr };
  renderPreviewFiltered();
}

function renderPreviewFiltered() {
  const q = (previewSearchEl && previewSearchEl.value) ? previewSearchEl.value.trim().toLowerCase() : "";
  const items = latestFC.features.filter(f => {
    const p = f.properties || {};
    const name = (p.name || "").toString().toLowerCase();
    const desc = (p.description || "").toString().toLowerCase();
    if (!q) return true;
    return name.includes(q) || desc.includes(q);
  });

  if (!previewListEl) return;
  previewListEl.innerHTML = "";
  if (items.length === 0) {
    const n = document.createElement("div");
    n.className = "small";
    n.innerText = "No features";
    previewListEl.appendChild(n);
    return;
  }

  items.forEach((f, idx) => {
    const p = f.properties || {};
    const id = p.id || `feature-${idx}`;
    const name = p.name || `Feature ${idx+1}`;
    const desc = p.description || "";
    const el = document.createElement("div");
    el.className = "list-item";
    el.dataset.id = id;

    const left = document.createElement("div");
    left.style.flex = "1";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerText = name;
    const d = document.createElement("div");
    d.className = "desc";
    d.innerText = desc;
    left.appendChild(meta);
    left.appendChild(d);

    const actions = document.createElement("div");
    actions.className = "list-actions";
    const btnZoom = document.createElement("div");
    btnZoom.className = "icon-sm";
    btnZoom.innerText = "Zoom";
    const btnDetails = document.createElement("div");
    btnDetails.className = "icon-sm";
    btnDetails.innerText = "Details";

    btnZoom.onclick = (ev) => { ev.stopPropagation(); zoomToFeature(f); highlightPreviewItem(id); };
    btnDetails.onclick = (ev) => { ev.stopPropagation(); showFeatureDetailsModal(f); highlightPreviewItem(id); };
    actions.appendChild(btnZoom);
    actions.appendChild(btnDetails);

    el.appendChild(left);
    el.appendChild(actions);
    previewListEl.appendChild(el);

    el.addEventListener("click", async (ev) => {
      if (ev.target === btnZoom || ev.target === btnDetails) return;
      highlightPreviewItem(id);
      let found = null;
      serverLayer.eachLayer(sl => { if (sl.feature && sl.feature.properties && sl.feature.properties.id === id) found = sl; });
      if (found) {
        if (clusteringEnabled && clusterGroup.hasLayer(found)) {
          clusterGroup.zoomToShowLayer(found, () => { found.openPopup(); });
        } else {
          found.openPopup();
          if (found.getLatLng) map.setView(found.getLatLng(), Math.max(map.getZoom(), 13));
        }
      } else {
        zoomToFeature(f);
      }
    });

    if (currentHighlightedId && currentHighlightedId === id) applyHighlightToElement(el);
  });
}

previewSearchEl && previewSearchEl.addEventListener("input", debounce(renderPreviewFiltered, 200));

/* highlight helpers */
function applyHighlightToElement(el) {
  if (!el) return;
  el.style.background = "var(--blue-soft)";
  el.style.borderLeft = "4px solid var(--blue)";
  el.style.boxShadow = "0 6px 18px rgba(11,22,36,0.06)";
}

function removeHighlightFromElement(el) {
  if (!el) return;
  el.style.background = "";
  el.style.borderLeft = "";
  el.style.boxShadow = "";
}

function highlightPreviewItem(id) {
  if (!previewListEl) return;
  if (currentHighlightedId) {
    const prev = previewListEl.querySelector(`[data-id="${currentHighlightedId}"]`);
    if (prev) removeHighlightFromElement(prev);
  }
  const el = previewListEl.querySelector(`[data-id="${id}"]`);
  if (el) {
    applyHighlightToElement(el);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    currentHighlightedId = id;
  } else {
    currentHighlightedId = null;
  }
}

function clearHighlight() {
  if (!previewListEl) return;
  if (currentHighlightedId) {
    const prev = previewListEl.querySelector(`[data-id="${currentHighlightedId}"]`);
    if (prev) removeHighlightFromElement(prev);
    currentHighlightedId = null;
  }
}

/* helper: zoom to feature & open popup AFTER zoom completes */
function zoomToFeature(feature) {
  if (!feature || !feature.geometry) return;
  const g = L.geoJSON(feature);
  const l = g.getLayers()[0];
  if (!l) return;

  if (l.getBounds) {
    map.fitBounds(l.getBounds().pad(0.2));
  } else if (l.getLatLng) {
    map.setView(l.getLatLng(), Math.max(map.getZoom(), 14));
  }

  const id = feature.properties && feature.properties.id;
  let found = null;
  serverLayer.eachLayer(sl => { if (sl.feature && sl.feature.properties && sl.feature.properties.id === id) found = sl; });

  if (found) {
    highlightPreviewItem(id);
    if (clusteringEnabled && clusterGroup.hasLayer(found)) {
      clusterGroup.zoomToShowLayer(found, () => { found.openPopup(); });
    } else {
      const onMove = () => { found.openPopup(); map.off("moveend", onMove); };
      map.on("moveend", onMove);
      setTimeout(() => { try { found.openPopup(); } catch(e) {} }, 500);
    }
  } else {
    const center = l.getLatLng ? l.getLatLng() : (l.getBounds && l.getBounds().getCenter());
    const onMove2 = () => {
      if (center) L.popup().setLatLng(center).setContent(`<b>${escapeHtml(feature.properties && feature.properties.name || '')}</b><div>${escapeHtml(feature.properties && feature.properties.description || '')}</div>`).openOn(map);
      map.off("moveend", onMove2);
    };
    map.on("moveend", onMove2);
    setTimeout(() => {
      if (center) L.popup().setLatLng(center).setContent(`<b>${escapeHtml(feature.properties && feature.properties.name || '')}</b><div>${escapeHtml(feature.properties && feature.properties.description || '')}</div>`).openOn(map);
    }, 600);
    clearHighlight();
  }
}

/* details modal (show properties + edit/delete actions) */
function showFeatureDetailsModal(feature) {
  const props = (feature && feature.properties) ? feature.properties : {};
  const html = `
    <div style="font-weight:700;margin-bottom:8px">${escapeHtml(props.name || 'Feature')}</div>
    <div style="margin-bottom:8px"><b>Id:</b> ${escapeHtml(props.id || '')}</div>
    <div style="margin-bottom:8px"><b>Description:</b><div style="margin-top:4px">${escapeHtml(props.description || '')}</div></div>
    <div style="margin-bottom:8px"><b>Geometry:</b><pre>${JSON.stringify(feature.geometry || {}, null, 2)}</pre></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button id="detail-edit" class="btn secondary" style="color:var(--blue)">Edit</button>
      <button id="detail-delete" class="btn" style="background:#ef4444;border:none">Delete</button>
      <button id="detail-close" class="btn secondary" style="color:var(--blue)">Close</button>
    </div>
  `;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.innerHTML = html;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById("detail-close").onclick = () => overlay.remove();
  document.getElementById("detail-edit").onclick = () => {
    overlay.remove();
    const id = props.id;
    let found = null;
    serverLayer.eachLayer(sl => { if (sl.feature && sl.feature.properties && sl.feature.properties.id === id) found = sl; });
    if (found) openInlineEdit(id, found);
    else showToast("Server feature not found for edit");
  };
  document.getElementById("detail-delete").onclick = async () => {
    if (!confirm("Delete this feature?")) return;
    overlay.remove();
    const id = props.id;
    try { await deleteFeature(id); } catch(e){ console.error(e); }
  };
}

/* -------------- Permalink / Export / Import -------------- */
document.getElementById("btn-permalink")?.addEventListener("click", () => {
  const c = map.getCenter(), z = map.getZoom();
  const url = `${location.origin}${location.pathname}?api=${encodeURIComponent(API_BASE)}#${c.lat.toFixed(6)},${c.lng.toFixed(6)},${z}`;
  navigator.clipboard.writeText(url).then(() => showToast("Permalink copied")).catch(() => showToast("Copy failed"));
});

document.getElementById("btn-export")?.addEventListener("click", async () => {
  try {
    showSpinner(true);
    const fc = await fetchFeaturesBBox();
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "export.geojson";
    a.click();
    showToast("Export siap");
  } catch (err) {
    console.error(err);
    showToast("Export error: " + err.message);
  } finally {
    showSpinner(false);
  }
});

document.getElementById("import-file")?.addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const txt = await f.text();
  try {
    const obj = JSON.parse(txt);
    const feats = obj.type === "FeatureCollection" && Array.isArray(obj.features) ? obj.features : null;
    if (!feats) { showToast("File bukan FeatureCollection"); return; }
    if (!confirm(`Import ${feats.length} features?`)) return;
    showSpinner(true);
    for (const feat of feats) {
      const geo = feat.geometry;
      const p = feat.properties || {};
      const r = await fetch(`${API_BASE}/features`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: p.name || "import", description: p.description || "", geojson: geo }) });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? ': ' + txt : ''}`);
      }
    }
    showToast("Import selesai");
    await renderServerFeaturesBBox();
  } catch (err) {
    console.error(err);
    showToast("Import error: " + err.message);
  } finally {
    showSpinner(false);
    ev.target.value = "";
  }
});

/* ------------ Sidebar interactions ------------- */
document.getElementById("toggle-sidebar")?.addEventListener("click", () => {
  const sb = document.getElementById("sidebar");
  if (sb) sb.classList.toggle("collapsed");
});

document.getElementById("btn-zoom-fit")?.addEventListener("click", async () => {
  try {
    showSpinner(true);
    const fc = await fetchFeaturesBBox();
    if (fc.features && fc.features.length > 0) {
      const g = L.geoJSON(fc);
      map.fitBounds(g.getBounds().pad(0.2));
      showToast("Fit to view");
    } else showToast("No features in view");
  } catch (err) {
    console.error(err);
    showToast("Error: " + err.message);
  } finally {
    showSpinner(false);
  }
});

document.getElementById("btn-toggle-cluster")?.addEventListener("click", () => {
  clusteringEnabled = !clusteringEnabled;
  addServerToMap();
  showToast("Clustering " + (clusteringEnabled ? "On" : "Off"));
});

/* ================= click map: reverse geocode + add feature ================= */
map.on("click", async (e) => {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  const popup = L.popup({ maxWidth: 320 })
    .setLatLng(e.latlng)
    .setContent(`<div>Loading location...</div>`)
    .openOn(map);

  let prettyName = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`;
    const resp = await fetch(url, { headers: { "Accept": "application/json" } });
    if (resp.ok) {
      const j = await resp.json().catch(() => null);
      if (j) {
        if (j.name && j.name.trim()) {
          prettyName = j.name;
        } else if (j.address && typeof j.address === "object") {
          const priority = ["attraction","tourism","building","amenity","leisure","shop","road","pedestrian","neighbourhood","suburb","village","town","city","county","state"];
          let found = null;
          for (const k of priority) {
            if (j.address[k]) { found = j.address[k]; break; }
          }
          if (found) prettyName = found;
          else if (j.display_name && j.display_name.trim()) {
            const parts = j.display_name.split(",").map(p => p.trim()).filter(Boolean);
            if (parts.length > 0) prettyName = parts.slice(0, Math.min(3, parts.length)).join(", ");
          }
        } else if (j.display_name && j.display_name.trim()) {
          const parts = j.display_name.split(",").map(p => p.trim()).filter(Boolean);
          if (parts.length > 0) prettyName = parts.slice(0, Math.min(3, parts.length)).join(", ");
        }
      }
    }
  } catch (err) {
    // ignore reverse geocode error - fallback to coords
  }

  popup.setContent(`<div><b>${escapeHtml(prettyName)}</b><div style="margin-top:8px">Lat: ${lat.toFixed(6)} &nbsp; Lon: ${lng.toFixed(6)}</div>
    <div style="margin-top:8px"><span id="add-here" class="popup-add-btn">Add here</span></div></div>`);

  setTimeout(() => {
    const btn = document.getElementById("add-here");
    if (!btn) return;
    btn.onclick = async () => {
      const out = await promptNameDesc(prettyName, "");
      if (!out) return;
      try {
        showSpinner(true);
        const body = { name: out.name, description: out.description, geojson: { type: "Point", coordinates: [lng, lat] } };
        const r = await fetch(`${API_BASE}/features`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? ': ' + txt : ''}`);
        }
        showToast("Saved");
        renderServerFeaturesBBox();
      } catch (err) {
        console.error(err);
        showToast("Save error: " + err.message, 3500);
      } finally {
        showSpinner(false);
        map.closePopup();
      }
    };
  }, 0);
});

/* ================= utility & initial render ================= */
function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

map.whenReady(() => renderServerFeaturesBBox());
