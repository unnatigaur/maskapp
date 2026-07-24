(() => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const fileNameEl = document.getElementById("file-name");
  const uploadStatus = document.getElementById("upload-status");

  const stepUpload = document.getElementById("step-upload");
  const stepReview = document.getElementById("step-review");
  const reviewSubhead = document.getElementById("review-subhead");
  const groupsContainer = document.getElementById("groups-container");
  const instructionsEl = document.getElementById("instructions");
  const maskBtn = document.getElementById("mask-btn");
  const backBtn = document.getElementById("back-btn");
  const maskStatus = document.getElementById("mask-status");

  let currentJobId = null;
  let pollTimer = null;

  // Categories that are safe to pre-check — clearly identifying fields.
  // Table columns / generic "other" fields / AI-guessed entities are
  // left unchecked by default so a bank statement isn't fully blacked
  // out until the user actually asks for that.
  const DEFAULT_ON_CATEGORIES = new Set(["identity", "contact"]);

  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 8 * 60 * 1000; // give up after 8 minutes of polling

  // ---------- dropzone ----------
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dropzone--drag"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dropzone--drag"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dropzone--drag");
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setStatus(uploadStatus, "Only PDF files are supported.", "error");
      return;
    }
    fileNameEl.textContent = file.name;
    startExtraction(file);
  }

  function setStatus(el, message, kind) {
    el.textContent = message || "";
    el.className = "status" + (kind ? ` status--${kind}` : "");
  }

  // ---------- step 1: kick off extraction ----------
  // The server hands back a job_id almost immediately and does the
  // actual OCR in the background — this request is intentionally not
  // where we wait for the slow part, so it can't be killed by a
  // reverse-proxy/load-balancer timeout the way a single long-blocking
  // request could be. See step 1b for where the real waiting happens.
  async function startExtraction(file) {
    setStatus(uploadStatus, "Uploading…", "loading");
    dropzone.classList.add("dropzone--busy");
    stopPolling();

    const formData = new FormData();
    formData.append("file", file);

    let res;
    try {
      res = await fetch("/extract", { method: "POST", body: formData });
    } catch (err) {
      dropzone.classList.remove("dropzone--busy");
      setStatus(uploadStatus, "Could not reach the server — check your connection and try again.", "error");
      return;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      dropzone.classList.remove("dropzone--busy");
      setStatus(uploadStatus, `Server returned an unexpected response (status ${res.status}). Check the server logs.`, "error");
      return;
    }

    if (!res.ok || !data.job_id) {
      dropzone.classList.remove("dropzone--busy");
      setStatus(uploadStatus, data.error || `Upload failed (status ${res.status}).`, "error");
      return;
    }

    currentJobId = data.job_id;
    setStatus(uploadStatus, "Scanning document and detecting fields — this can take a while for multilingual or multi-page documents…", "loading");
    pollExtractionStatus(data.job_id, Date.now());
  }

  // ---------- step 1b: poll until OCR/detection finishes ----------
  function pollExtractionStatus(jobId, startedAt) {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (jobId !== currentJobId) return; // a newer upload superseded this one

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        dropzone.classList.remove("dropzone--busy");
        setStatus(uploadStatus, "Still not done after several minutes — something is likely stuck server-side. Check the server logs.", "error");
        return;
      }

      let res, data;
      try {
        res = await fetch(`/extract/status/${jobId}`);
        data = await res.json();
      } catch (err) {
        // A single polling request dropping doesn't mean the job failed —
        // the background work keeps running regardless — so just retry.
        pollExtractionStatus(jobId, startedAt);
        return;
      }

      if (data.status === "processing") {
        pollExtractionStatus(jobId, startedAt);
        return;
      }

      dropzone.classList.remove("dropzone--busy");

      if (data.status === "done") {
        renderGroups(data);
        setStatus(uploadStatus, "", null);
        stepUpload.hidden = true;
        stepReview.hidden = false;
        return;
      }

      // status === "error" (or anything unrecognized)
      setStatus(uploadStatus, data.error || "Something went wrong reading that PDF.", "error");
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // ---------- step 2: render detected field groups ----------
  function renderGroups(data) {
    groupsContainer.innerHTML = "";
    reviewSubhead.textContent = data.num_pages
      ? `${data.num_pages} page(s) scanned. Select what to mask — checking one masks every occurrence.`
      : "Select what to mask — checking one masks every occurrence.";

    if (!data.groups || data.groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "subhead";
      empty.textContent = data.message || "No standard fields were detected automatically. Describe what to mask below instead.";
      groupsContainer.appendChild(empty);
      return;
    }

    const byCategory = {};
    for (const g of data.groups) {
      (byCategory[g.category_label] = byCategory[g.category_label] || []).push(g);
    }

    for (const [categoryLabel, groups] of Object.entries(byCategory)) {
      const section = document.createElement("div");
      section.className = "group-section";

      const legend = document.createElement("div");
      legend.className = "fields__legend";
      legend.textContent = categoryLabel.toUpperCase();
      section.appendChild(legend);

      const grid = document.createElement("div");
      grid.className = "fields__grid";

      for (const g of groups) {
        const label = document.createElement("label");
        label.className = "field-toggle field-toggle--rich";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = g.group_id;
        checkbox.checked = DEFAULT_ON_CATEGORIES.has(g.category);
        checkbox.dataset.groupId = g.group_id;

        const box = document.createElement("span");
        box.className = "field-toggle__box";

        const textWrap = document.createElement("span");
        textWrap.className = "field-toggle__text";

        const title = document.createElement("span");
        title.className = "field-toggle__label";
        title.textContent = `${g.display_label} (${g.count} found)`;

        const sample = document.createElement("span");
        sample.className = "field-toggle__sample";
        const preview = (g.sample_values || []).map(truncate).join(" · ");
        sample.textContent = preview;

        textWrap.appendChild(title);
        if (preview) textWrap.appendChild(sample);

        label.appendChild(checkbox);
        label.appendChild(box);
        label.appendChild(textWrap);
        grid.appendChild(label);
      }

      section.appendChild(grid);
      groupsContainer.appendChild(section);
    }
  }

  function truncate(s, n = 42) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // ---------- step 3: mask & download ----------
  backBtn.addEventListener("click", () => {
    stopPolling();
    stepReview.hidden = true;
    stepUpload.hidden = false;
    fileInput.value = "";
    fileNameEl.textContent = "";
    instructionsEl.value = "";
    setStatus(maskStatus, "", null);
    currentJobId = null;
  });

  maskBtn.addEventListener("click", async () => {
    if (!currentJobId) return;
    const selected = Array.from(groupsContainer.querySelectorAll("input[type=checkbox]:checked"))
      .map((cb) => cb.dataset.groupId);
    const instructions = instructionsEl.value.trim();

    if (selected.length === 0 && !instructions) {
      setStatus(maskStatus, "Select at least one field, or describe what to mask.", "error");
      return;
    }

    setStatus(maskStatus, "Applying redactions…", "loading");
    maskBtn.disabled = true;

    let res;
    try {
      res = await fetch("/mask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: currentJobId, group_ids: selected, instructions }),
      });
    } catch (err) {
      setStatus(maskStatus, "Could not reach the server — check your connection and try again.", "error");
      maskBtn.disabled = false;
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = data.error
        || `Server returned ${res.status}${res.status === 504 || res.status === 502 ? " (timed out — try a smaller or lower-resolution PDF)" : ""}.`;
      setStatus(maskStatus, detail, "error");
      maskBtn.disabled = false;
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "masked_output.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus(maskStatus, "Done — your masked PDF has downloaded.", "success");
    maskBtn.disabled = false;
  });
})();
