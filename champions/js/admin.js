(function () {
  "use strict";
  const supabase = window.mobihealthSupabase;

  let currentAdmin = null; // { email, role }
  let allApplications = [];
  let allAdmins = [];

  const $ = (id) => document.getElementById(id);
  const loginScreen = $("loginScreen");
  const deniedScreen = $("deniedScreen");
  const dashboardScreen = $("dashboardScreen");

  function showOnly(screen) {
    [loginScreen, deniedScreen, dashboardScreen].forEach((s) => (s.style.display = "none"));
    screen.style.display = screen === dashboardScreen ? "flex" : "flex";
  }

  // ---------------- Auth ----------------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("loginEmail").value.trim().toLowerCase();
    const btn = $("loginSubmitBtn");
    const msg = $("loginMsg");
    btn.disabled = true;
    btn.textContent = "Sending...";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    });
    btn.disabled = false;
    btn.textContent = "Send Login Link";
    msg.classList.remove("error", "success");
    if (error) {
      msg.textContent = error.message;
      msg.classList.add("error", "show");
    } else {
      msg.textContent = "Check your email for a secure login link.";
      msg.classList.add("success", "show");
    }
  });

  $("signOutBtn").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });
  $("signOutDeniedBtn").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });

  async function checkSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { showOnly(loginScreen); return; }

    const email = session.user.email.toLowerCase();
    const { data: adminRow, error } = await supabase
      .from("champion_admins")
      .select("email, role, status")
      .eq("email", email)
      .eq("status", "active")
      .maybeSingle();

    if (error || !adminRow) {
      showOnly(deniedScreen);
      return;
    }
    currentAdmin = { email: adminRow.email, role: adminRow.role };
    $("meEmail").textContent = currentAdmin.email;
    if (currentAdmin.role !== "super_admin") {
      $("navAdmins").style.display = "none";
    }
    showOnly(dashboardScreen);
    await logActivity("Admin login", "");
    await loadEverything();
  }

  // ---------------- Nav ----------------
  document.querySelectorAll(".admin-nav button[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".admin-nav button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".admin-view").forEach((v) => v.classList.remove("active"));
      $(btn.dataset.view).classList.add("active");
      $("topbarTitle").textContent = btn.textContent;
      $("sidebar").classList.remove("open");
      if (btn.dataset.view === "activityView") loadActivityLog();
      if (btn.dataset.view === "adminsView") renderAdmins();
    });
  });
  $("menuToggle").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  // ---------------- Activity log ----------------
  async function logActivity(action, details) {
    if (!currentAdmin) return;
    await supabase.from("champion_activity_log").insert({ admin_email: currentAdmin.email, action, details: details || "" });
  }
  async function loadActivityLog() {
    const { data } = await supabase.from("champion_activity_log").select("*").order("created_at", { ascending: false }).limit(200);
    const list = $("activityLogList");
    list.innerHTML = "";
    (data || []).forEach((row) => {
      const el = document.createElement("div");
      el.className = "log-item";
      el.innerHTML = `<div><span class="who">${escapeHtml(row.admin_email)}</span> — ${escapeHtml(row.action)}${row.details ? " — " + escapeHtml(row.details) : ""}</div><div class="when">${new Date(row.created_at).toLocaleString()}</div>`;
      list.appendChild(el);
    });
  }

  // ---------------- Data load ----------------
  async function loadEverything() {
    await Promise.all([loadApplications(), loadSettingsForm(), currentAdmin.role === "super_admin" ? loadAdmins() : Promise.resolve()]);
    renderStats();
    renderRecent();
    populateFilters();
    renderApplicationsTable();
  }

  async function loadApplications() {
    const { data, error } = await supabase.from("champion_applications").select("*").order("created_at", { ascending: false });
    if (!error) allApplications = data || [];
  }

  function renderStats() {
    const count = (s) => allApplications.filter((a) => a.status === s).length;
    $("statTotal").textContent = allApplications.length;
    $("statNew").textContent = count("New");
    $("statReview").textContent = count("Under Review");
    $("statShort").textContent = count("Shortlisted") + count("Interview");
    $("statSelected").textContent = count("Selected");
    $("statRejected").textContent = count("Not Selected");
  }

  function renderRecent() {
    const tbody = document.querySelector("#recentTable tbody");
    tbody.innerHTML = "";
    allApplications.slice(0, 8).forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><a class="row-link" data-id="${a.id}">${a.application_number}</a></td><td>${escapeHtml(a.full_name)}</td><td>${escapeHtml(a.department)}</td><td>${escapeHtml(a.level)}</td><td>${new Date(a.created_at).toLocaleDateString()}</td><td>${statusBadge(a.status)}</td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".row-link").forEach((el) => el.addEventListener("click", () => openDrawer(el.dataset.id)));
  }

  function statusBadge(status) {
    return `<span class="badge badge-${status.replace(/\s/g, "")}">${status}</span>`;
  }

  function populateFilters() {
    const faculties = [...new Set(allApplications.map((a) => a.faculty).filter(Boolean))].sort();
    const levels = [...new Set(allApplications.map((a) => a.level).filter(Boolean))].sort();
    const fSel = $("filterFaculty"), lSel = $("filterLevel");
    fSel.innerHTML = '<option value="">All Faculties</option>' + faculties.map((f) => `<option>${escapeHtml(f)}</option>`).join("");
    lSel.innerHTML = '<option value="">All Levels</option>' + levels.map((l) => `<option>${escapeHtml(l)}</option>`).join("");
  }

  function getFiltered() {
    const q = $("searchInput").value.trim().toLowerCase();
    const faculty = $("filterFaculty").value;
    const level = $("filterLevel").value;
    const status = $("filterStatus").value;
    return allApplications.filter((a) => {
      if (faculty && a.faculty !== faculty) return false;
      if (level && a.level !== level) return false;
      if (status && a.status !== status) return false;
      if (q) {
        const hay = `${a.full_name} ${a.email} ${a.application_number} ${a.department} ${a.matric_number}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderApplicationsTable() {
    const filtered = getFiltered();
    const tbody = document.querySelector("#applicationsTable tbody");
    tbody.innerHTML = "";
    $("applicationsEmpty").style.display = filtered.length ? "none" : "block";
    filtered.forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><a class="row-link" data-id="${a.id}">${a.application_number}</a></td>
        <td>${escapeHtml(a.full_name)}</td>
        <td>${escapeHtml(a.faculty)}</td>
        <td>${escapeHtml(a.department)}</td>
        <td>${escapeHtml(a.level)}</td>
        <td>${escapeHtml(a.email)}</td>
        <td>${escapeHtml(a.phone)}</td>
        <td>${new Date(a.created_at).toLocaleDateString()}</td>
        <td>${statusBadge(a.status)}</td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".row-link").forEach((el) => el.addEventListener("click", () => openDrawer(el.dataset.id)));
  }
  ["searchInput", "filterFaculty", "filterLevel", "filterStatus"].forEach((id) => {
    $(id).addEventListener("input", renderApplicationsTable);
    $(id).addEventListener("change", renderApplicationsTable);
  });

  // ---------------- CSV export ----------------
  $("exportCsvBtn").addEventListener("click", async () => {
    const rows = getFiltered();
    const cols = ["application_number", "full_name", "email", "phone", "faculty", "department", "level", "matric_number", "status", "created_at"];
    const csv = [cols.join(",")].concat(
      rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))
    ).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `mobihealth-champions-applications-${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    await logActivity("Exported applications", `${rows.length} rows`);
  });

  // ---------------- Detail drawer ----------------
  async function openDrawer(id) {
    const a = allApplications.find((x) => x.id === id);
    if (!a) return;
    $("drawerName").textContent = a.full_name;
    const photoUrl = a.profile_photo_path ? await signedUrl("champion-photos", a.profile_photo_path) : null;
    const cvUrl = a.cv_path ? await signedUrl("champion-cvs", a.cv_path) : null;

    $("drawerBody").innerHTML = `
      <div class="detail-section">
        <h4>Status</h4>
        <select class="status-select" id="statusSelect">
          ${["New", "Under Review", "Shortlisted", "Interview", "Selected", "Not Selected"].map((s) => `<option ${s === a.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="detail-section">
        <h4>Personal Information</h4>
        ${detailRow("Application ID", a.application_number)}
        ${detailRow("Full Name", a.full_name)}
        ${detailRow("Preferred Name", a.preferred_name)}
        ${detailRow("Email", a.email)}
        ${detailRow("Phone", a.phone)}
        ${detailRow("WhatsApp", a.whatsapp)}
        ${detailRow("Gender", a.gender)}
        ${detailRow("Age Range", a.age_range)}
        ${detailRow("Matric Number", a.matric_number)}
        ${detailRow("Faculty", a.faculty)}
        ${detailRow("Department", a.department)}
        ${detailRow("Level", a.level)}
        ${detailRow("Graduation Year", a.graduation_year)}
      </div>
      <div class="detail-section">
        <h4>About &amp; Experience</h4>
        ${detailBlock("Introduction", a.introduction)}
        ${detailBlock("Passions", (a.passions || []).join(", "))}
        ${detailBlock("Prior Experience", a.has_prior_experience ? (a.previous_experience || "Yes") : "No")}
        ${detailBlock("Leadership Roles", a.leadership_roles)}
      </div>
      <div class="detail-section">
        <h4>Motivation</h4>
        ${detailBlock("Why Mobihealth", a.why_mobihealth)}
        ${detailBlock("What a Champion should do", a.champion_role)}
        ${detailBlock("Promotion Strategy", a.promotion_strategy)}
        ${detailBlock("One-Month Idea", a.one_month_idea)}
        ${detailBlock("Contribution Areas", (a.contribution_areas || []).join(", "))}
        ${detailBlock("Champion Idea", a.champion_idea)}
        ${detailBlock("Unique Strength", a.unique_strength)}
      </div>
      <div class="detail-section">
        <h4>Availability</h4>
        ${detailRow("Communication (1-5)", a.communication_rating)}
        ${detailRow("Public Speaking (1-5)", a.public_speaking_rating)}
        ${detailRow("Social Media Activity", a.social_media_activity)}
        ${detailRow("Platforms", (a.social_platforms || []).join(", "))}
        ${detailRow("Weekly Availability", a.weekly_availability)}
        ${detailRow("Comfortable at Events", a.campus_events ? "Yes" : "No")}
        ${detailRow("Will Share on Social", a.social_media_sharing)}
        ${detailRow("Instagram", a.instagram)}
        ${detailRow("LinkedIn", a.linkedin)}
        ${detailRow("Referral Source", a.referral_source)}
      </div>
      <div class="detail-section">
        <h4>Documents</h4>
        ${photoUrl ? `<a class="doc-link" href="${photoUrl}" target="_blank" rel="noopener">View Profile Photo</a>` : "<p style='color:var(--text-muted);font-size:0.85rem;'>No photo on file.</p>"}
        ${cvUrl ? `<a class="doc-link" href="${cvUrl}" target="_blank" rel="noopener">View CV</a>` : ""}
      </div>
      <div class="detail-section">
        ${detailBlock("Additional Information", a.additional_information)}
      </div>
      <div class="detail-section notes-box">
        <h4>Private Admin Notes</h4>
        <textarea id="notesField" placeholder="Add a private note (not visible to applicants)...">${escapeHtml(a.admin_notes || "")}</textarea>
        <button class="btn btn-primary btn-sm" id="saveNotesBtn" style="margin-top:10px;">Save Note</button>
      </div>
    `;

    $("statusSelect").addEventListener("change", async (e) => {
      const newStatus = e.target.value;
      const prevStatus = a.status;
      const { error } = await supabase.from("champion_applications").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", a.id);
      if (!error) {
        await supabase.from("champion_status_history").insert({ application_id: a.id, previous_status: prevStatus, new_status: newStatus, changed_by: currentAdmin.email });
        await logActivity("Application status changed", `${a.application_number}: ${prevStatus} → ${newStatus}`);
        a.status = newStatus;
        renderStats(); renderRecent(); renderApplicationsTable();
      }
    });

    $("saveNotesBtn").addEventListener("click", async () => {
      const notes = $("notesField").value;
      const { error } = await supabase.from("champion_applications").update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq("id", a.id);
      if (!error) {
        a.admin_notes = notes;
        await logActivity("Admin note added", a.application_number);
        $("saveNotesBtn").textContent = "Saved!";
        setTimeout(() => ($("saveNotesBtn").textContent = "Save Note"), 1500);
      }
    });

    await logActivity("Application viewed", a.application_number);
    $("drawerOverlay").classList.add("open");
    $("drawer").classList.add("open");
  }
  $("drawerCloseBtn").addEventListener("click", closeDrawer);
  $("drawerOverlay").addEventListener("click", closeDrawer);
  function closeDrawer() { $("drawerOverlay").classList.remove("open"); $("drawer").classList.remove("open"); }

  async function signedUrl(bucket, path) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    return error ? null : data.signedUrl;
  }

  function detailRow(k, v) { return `<div class="detail-row"><span class="k">${k}</span><span class="v">${v ? escapeHtml(String(v)) : "—"}</span></div>`; }
  function detailBlock(k, v) { return `<div class="detail-block"><div class="k">${k}</div><div class="v">${v ? escapeHtml(String(v)) : "—"}</div></div>`; }

  // ---------------- Admins management ----------------
  async function loadAdmins() {
    const { data } = await supabase.from("champion_admins").select("*").order("created_at", { ascending: true });
    allAdmins = data || [];
  }
  function renderAdmins() {
    const tbody = $("adminsTableBody");
    tbody.innerHTML = "";
    allAdmins.forEach((admin) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(admin.email)}</td>
        <td>${new Date(admin.created_at).toLocaleDateString()}</td>
        <td><span class="pill-role ${admin.role === "super_admin" ? "pill-super" : "pill-admin"}">${admin.role === "super_admin" ? "Super Admin" : "Admin"}</span></td>
        <td>${admin.status === "active" ? "Active" : "Removed"}</td>
        <td class="admin-table-actions">
          ${admin.status === "active" && admin.role !== "super_admin" ? `<button class="btn btn-outline btn-sm" data-remove="${admin.id}">Remove</button>` : ""}
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this administrator's access?")) return;
        const { error } = await supabase.from("champion_admins").update({ status: "removed" }).eq("id", btn.dataset.remove);
        if (!error) {
          await logActivity("Admin removed", btn.closest("tr").children[0].textContent);
          await loadAdmins();
          renderAdmins();
        }
      });
    });
  }
  $("addAdminBtn").addEventListener("click", async () => {
    const email = $("newAdminEmail").value.trim().toLowerCase();
    const msg = $("adminMsg");
    msg.classList.remove("error", "success");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = "Enter a valid email address."; msg.classList.add("error", "show"); return;
    }
    const { error } = await supabase.from("champion_admins").insert({ email, role: "admin", added_by: currentAdmin.email, status: "active" });
    if (error) {
      msg.textContent = error.code === "23505" ? "This email is already an administrator." : error.message;
      msg.classList.add("error", "show");
    } else {
      msg.textContent = "Administrator added successfully."; msg.classList.add("success", "show");
      $("newAdminEmail").value = "";
      await logActivity("Admin added", email);
      await loadAdmins();
      renderAdmins();
    }
  });

  // ---------------- Settings ----------------
  async function loadSettingsForm() {
    const { data } = await supabase.from("champion_settings").select("*").eq("id", 1).single();
    if (!data) return;
    $("setProgramName").value = data.program_name || "";
    $("setProgramDesc").value = data.program_description || "";
    $("setStatus").value = data.application_status || "open";
    const d = new Date(data.deadline);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $("setDeadline").value = local;
  }
  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("settingsMsg");
    msg.classList.remove("error", "success");
    const { error } = await supabase.from("champion_settings").update({
      program_name: $("setProgramName").value.trim(),
      program_description: $("setProgramDesc").value.trim(),
      application_status: $("setStatus").value,
      deadline: new Date($("setDeadline").value).toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: currentAdmin.email,
    }).eq("id", 1);
    if (error) {
      msg.textContent = error.message; msg.classList.add("error", "show");
    } else {
      msg.textContent = "Settings saved."; msg.classList.add("success", "show");
      await logActivity("Settings updated", `status=${$("setStatus").value}`);
    }
  });

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  supabase.auth.onAuthStateChange(() => checkSession());
  checkSession();
})();
