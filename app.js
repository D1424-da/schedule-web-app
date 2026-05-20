const STORAGE_KEY = "weekly-schedule-v1";

const STATUS_OPTIONS = ["現場", "内業", "打合せ", "移動", "休み", "午前休", "午後休", "有給", "午前有", "午後有"];
const DEFAULT_STAFF_ACCOUNTS = [
  { id: "本社A", name: "本社A" },
  { id: "本社B", name: "本社B" },
  { id: "支社A", name: "支社A" },
  { id: "支社B", name: "支社B" },
  { id: "支社C", name: "支社C" },
  { id: "支社D", name: "支社D" },
];
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const AUTH_EMAIL_DOMAIN = "schedule.local";
const ADMIN_LOGIN_ID = "イオリ技建";
const ADMIN_PASSWORD = "123456";

const pageMode = document.body?.dataset?.page || "home";
const isPersonalPage = pageMode === "personal";
const isOverallPage = pageMode === "overall";
const requiresAuth = pageMode === "personal" || pageMode === "overall";
const FIRESTORE_COLLECTION = "appData";
const FIRESTORE_DOCUMENT = "weeklySchedule";

let firestoreDb = null;
let firebaseAuth = null;
let cloudSyncEnabled = false;
let cloudSaveTimer = null;
let cloudLoading = false;
let cloudUnsubscribe = null;
let lastKnownRemoteUpdatedAt = "";
let lastLocalSaveUpdatedAt = "";
let syncAlertTimer = null;
let currentFirebaseUser = null;
let authObserverReady = false;
let appReady = false;

const state = {
  currentWeekStart: getMonday(new Date()),
  staff: DEFAULT_STAFF_ACCOUNTS.map((item) => item.name),
  staffAccounts: DEFAULT_STAFF_ACCOUNTS.map((item) => toStaffAccount(item)),
  currentUser: "",
  currentUserId: "",
  isAdmin: false,
  manualEntries: {},
  settings: {
    holidayAutoEnabled: true,
    dullStartMonth: 1,
    dullEndMonth: 3,
    busyStartMonth: 4,
    busyEndMonth: 12,
    biweeklyPattern: "1-3",
  },
  holidaysByYear: {},
  editTarget: null,
};

const refs = {
  prevWeekBtn: document.getElementById("prevWeekBtn"),
  nextWeekBtn: document.getElementById("nextWeekBtn"),
  todayBtn: document.getElementById("todayBtn"),
  weekLabel: document.getElementById("weekLabel"),
  scheduleTable: document.getElementById("scheduleTable"),
  notice: document.getElementById("notice"),
  currentUserLabel: document.getElementById("currentUserLabel"),
  openLoginBtn: document.getElementById("openLoginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  holidayAutoEnabled: document.getElementById("holidayAutoEnabled"),
  dullStartMonth: document.getElementById("dullStartMonth"),
  dullEndMonth: document.getElementById("dullEndMonth"),
  busyStartMonth: document.getElementById("busyStartMonth"),
  busyEndMonth: document.getElementById("busyEndMonth"),
  biweeklyPattern: document.getElementById("biweeklyPattern"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  editDialog: document.getElementById("editDialog"),
  editForm: document.getElementById("editForm"),
  editMeta: document.getElementById("editMeta"),
  statusInput: document.getElementById("statusInput"),
  workInput: document.getElementById("workInput"),
  placeInput: document.getElementById("placeInput"),
  repeatEnabled: document.getElementById("repeatEnabled"),
  repeatCount: document.getElementById("repeatCount"),
  clearEntryBtn: document.getElementById("clearEntryBtn"),
  cancelEntryBtn: document.getElementById("cancelEntryBtn"),
  loginDialog: document.getElementById("loginDialog"),
  loginForm: document.getElementById("loginForm"),
  loginIdInput: document.getElementById("loginIdInput"),
  loginPasswordInput: document.getElementById("loginPasswordInput"),
  loginCancelBtn: document.getElementById("loginCancelBtn"),
  registerNameInput: document.getElementById("registerNameInput"),
  registerBirthdayInput: document.getElementById("registerBirthdayInput"),
  registerUserBtn: document.getElementById("registerUserBtn"),
  toggleRegisterBtn: document.getElementById("toggleRegisterBtn"),
  registerPanel: document.getElementById("registerPanel"),
  userOrderList: document.getElementById("userOrderList"),
  adminSettingsSection: document.getElementById("adminSettingsSection"),
  adminRegisterSection: document.getElementById("adminRegisterSection"),
  adminOnlyNotice: document.getElementById("adminOnlyNotice"),
  enableNotificationsBtn: document.getElementById("enableNotificationsBtn"),
  notificationStatus: document.getElementById("notificationStatus"),
  syncAlert: document.getElementById("syncAlert"),
};

init();

async function init() {
  initCloudStore();
  await waitForInitialAuthState();
  await loadState();
  state.currentWeekStart = getMonday(new Date());

  buildMonthOptions();
  syncLoginForm();
  syncAuthUi();
  syncAdminUi();
  syncSettingsToForm();
  syncNotificationUi();
  bindEvents();
  updatePageLock();

  if (currentFirebaseUser) {
    startCloudListener();
  }

  appReady = true;
  await render();

  if (requiresAuth && !currentFirebaseUser && refs.loginDialog) {
    refs.loginDialog.showModal();
  }
}

function bindEvents() {
  if (refs.prevWeekBtn) {
    refs.prevWeekBtn.addEventListener("click", async () => {
      state.currentWeekStart = addDays(state.currentWeekStart, -7);
      await render();
    });
  }

  if (refs.nextWeekBtn) {
    refs.nextWeekBtn.addEventListener("click", async () => {
      state.currentWeekStart = addDays(state.currentWeekStart, 7);
      await render();
    });
  }

  if (refs.todayBtn) {
    refs.todayBtn.addEventListener("click", async () => {
      state.currentWeekStart = getMonday(new Date());
      await render();
    });
  }

  if (refs.toggleSettingsBtn && refs.settingsPanel) {
    refs.toggleSettingsBtn.addEventListener("click", () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      refs.settingsPanel.classList.toggle("hidden");
    });
  }

  if (refs.openLoginBtn && refs.loginDialog) {
    refs.openLoginBtn.addEventListener("click", () => {
      refs.loginDialog.showModal();
    });
  }

  if (refs.enableNotificationsBtn) {
    refs.enableNotificationsBtn.addEventListener("click", async () => {
      await requestBrowserNotificationPermission();
    });
  }

  if (refs.loginForm && refs.loginIdInput && refs.loginPasswordInput) {
    refs.loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const loginId = normalizeLoginId(refs.loginIdInput.value);
      const loginPassword = normalizeLoginPassword(refs.loginPasswordInput.value);
      if (!loginId) {
        return;
      }
      if (!firebaseAuth) {
        setNotice("Firebase Authentication の設定が未完了です。");
        return;
      }

      state.currentUser = normalizeDisplayName(refs.loginIdInput.value);
      state.currentUserId = loginId;

      try {
        await ensureAdminAccount(loginId, loginPassword);
        await firebaseAuth.signInWithEmailAndPassword(buildAuthEmail(loginId), loginPassword);
      } catch (error) {
        const migrated = await migrateLegacyAccountOnLogin(loginId, loginPassword, error);
        if (!migrated) {
          setNotice("IDまたはパスワード（誕生日）が正しくありません。新規登録後に再度お試しください。");
        }
      }
    });
  }

  if (refs.logoutBtn) {
    refs.logoutBtn.addEventListener("click", async () => {
      if (!firebaseAuth) {
        return;
      }
      await firebaseAuth.signOut();
    });
  }

  if (refs.loginCancelBtn && refs.loginDialog) {
    refs.loginCancelBtn.addEventListener("click", () => {
      refs.loginDialog.close();
    });
  }

  if (refs.saveSettingsBtn) {
    refs.saveSettingsBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      if (!refs.holidayAutoEnabled) {
        return;
      }

      state.settings.holidayAutoEnabled = refs.holidayAutoEnabled.checked;
      state.settings.dullStartMonth = Number(refs.dullStartMonth?.value || state.settings.dullStartMonth);
      state.settings.dullEndMonth = Number(refs.dullEndMonth?.value || state.settings.dullEndMonth);
      state.settings.busyStartMonth = Number(refs.busyStartMonth?.value || state.settings.busyStartMonth);
      state.settings.busyEndMonth = Number(refs.busyEndMonth?.value || state.settings.busyEndMonth);
      state.settings.biweeklyPattern = refs.biweeklyPattern?.value || state.settings.biweeklyPattern;

      saveState();
      setNotice("休日設定を保存しました。");
      await render();
    });
  }

  if (refs.toggleRegisterBtn && refs.registerPanel) {
    refs.toggleRegisterBtn.addEventListener("click", () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      refs.registerPanel.classList.toggle("hidden");
    });
  }

  if (refs.registerUserBtn && refs.registerNameInput && refs.registerBirthdayInput) {
    refs.registerUserBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      const displayName = normalizeDisplayName(refs.registerNameInput.value);
      const loginId = normalizeLoginId(displayName);
      const birthday = normalizeLoginPassword(refs.registerBirthdayInput.value);

      if (!displayName) {
        setNotice("名前（ID）を入力してください。");
        return;
      }
      if (!birthday || birthday.length !== 8) {
        setNotice("誕生日は8桁（YYYYMMDD）で入力してください。");
        return;
      }
      if (!firebaseAuth) {
        setNotice("Firebase Authentication の設定が未完了です。");
        return;
      }
      if (findAccountByLoginId(loginId)) {
        setNotice("同じ名前（ID）はすでに登録されています。");
        return;
      }

      try {
        if (isPersonalPage) {
          state.currentUser = displayName;
          state.currentUserId = loginId;
          await firebaseAuth.createUserWithEmailAndPassword(buildAuthEmail(loginId), birthday);
        } else {
          await createUserWithoutSwitchingSession(buildAuthEmail(loginId), birthday);
        }

        state.staffAccounts.push(toStaffAccount({ id: loginId, name: displayName }));
        refreshStaffFromAccounts();
        saveState();

        refs.registerNameInput.value = "";
        refs.registerBirthdayInput.value = "";

        if (isPersonalPage && refs.loginIdInput && refs.loginPasswordInput) {
          refs.loginIdInput.value = displayName;
          refs.loginPasswordInput.value = "";
          refs.loginPasswordInput.focus();
        }

        setNotice(`${displayName} を新規登録しました。ログインできます。`);
        await render();
      } catch (error) {
        setNotice(convertFirebaseAuthError(error));
      }
    });
  }

  if (refs.userOrderList) {
    refs.userOrderList.addEventListener("click", async (event) => {
      if (!canManageAdminSettings()) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.action;
      const index = Number(button.dataset.index);
      if (Number.isNaN(index)) {
        return;
      }

      if (action === "delete") {
        const targetAccount = state.staffAccounts[index];
        if (!targetAccount) {
          return;
        }

        const ok = confirm(`${targetAccount.name} を削除します。よろしいですか？`);
        if (!ok) {
          return;
        }

        state.staffAccounts.splice(index, 1);
        deleteManualEntriesByUserName(targetAccount.name);

        if (state.currentUser === targetAccount.name) {
          state.currentUser = "";
          state.currentUserId = "";
        }

        refreshStaffFromAccounts();
        saveState();
        setNotice(`${targetAccount.name} を削除しました。`);
        await render();
        return;
      }

      const moved = moveStaffAccount(index, action === "up" ? -1 : 1);
      if (!moved) {
        return;
      }

      refreshStaffFromAccounts();
      saveState();
      setNotice("表示順を更新しました。");
      await render();
    });
  }

  if (refs.editForm) {
    refs.editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.editTarget) {
        return;
      }
      if (!canEditRow(state.editTarget.name)) {
        setNotice("自分の行のみ編集できます。");
        return;
      }

      const entryData = {
        status: refs.statusInput?.value || "現場",
        work: refs.workInput?.value.trim() || "",
        place: refs.placeInput?.value.trim() || "",
        source: "manual",
        updatedAt: new Date().toISOString(),
      };

      const repeatDays = refs.repeatEnabled?.checked ? Number(refs.repeatCount?.value || 1) : 1;
      const savedCount = saveManualEntriesWithRepeat(state.editTarget.name, state.editTarget.date, entryData, repeatDays);

      saveState();
      refs.editDialog?.close();
      setNotice(`予定を保存しました。${savedCount}件反映`);
      await render();
    });
  }

  if (refs.clearEntryBtn) {
    refs.clearEntryBtn.addEventListener("click", async () => {
      if (!state.editTarget) {
        return;
      }
      if (!canEditRow(state.editTarget.name)) {
        setNotice("自分の行のみ編集できます。");
        return;
      }

      const key = entryKey(state.editTarget.name, state.editTarget.date);
      delete state.manualEntries[key];
      saveState();
      refs.editDialog?.close();
      setNotice("手動入力を解除しました。");
      await render();
    });
  }

  if (refs.cancelEntryBtn) {
    refs.cancelEntryBtn.addEventListener("click", () => {
      refs.editDialog?.close();
    });
  }
}

function initCloudStore() {
  const config = window.__FIREBASE_CONFIG__;
  if (!config || !config.projectId || config.projectId === "YOUR_PROJECT_ID") {
    return;
  }

  if (!window.firebase || !window.firebase.firestore || !window.firebase.auth) {
    return;
  }

  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(config);
  }

  firebaseAuth = window.firebase.auth();
  firestoreDb = window.firebase.firestore();
  cloudSyncEnabled = true;
}

function waitForInitialAuthState() {
  if (!firebaseAuth) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    firebaseAuth.onAuthStateChanged(async (user) => {
      currentFirebaseUser = user;

      if (!authObserverReady) {
        authObserverReady = true;
        resolve();
        return;
      }

      if (appReady) {
        await handleAuthStateChanged(user);
      }
    });
  });
}

async function render() {
  if (requiresAuth && !currentFirebaseUser) {
    return;
  }

  const weekDates = getWeekDates(state.currentWeekStart);
  await ensureHolidayCache(weekDates);

  renderWeekLabel(weekDates);
  renderTable(weekDates);
  renderUserOrderList();
}

function startCloudListener() {
  if (!cloudSyncEnabled || !currentFirebaseUser || cloudUnsubscribe) {
    return;
  }

  cloudUnsubscribe = firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).onSnapshot(
    async (snapshot) => {
      if (!snapshot.exists) {
        return;
      }

      const cloudData = snapshot.data();
      const remoteUpdatedAt = normalizeTimestamp(cloudData.updatedAt);
      if (!remoteUpdatedAt) {
        return;
      }

      if (!lastKnownRemoteUpdatedAt) {
        lastKnownRemoteUpdatedAt = remoteUpdatedAt;
        return;
      }

      if (remoteUpdatedAt === lastKnownRemoteUpdatedAt) {
        return;
      }

      lastKnownRemoteUpdatedAt = remoteUpdatedAt;
      applyLoadedData(cloudData, false);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
      await render();

      if (remoteUpdatedAt !== lastLocalSaveUpdatedAt) {
        notifyRemoteUpdate(cloudData);
      }
    },
    () => {
      setNotice("Firestore監視に失敗しました。再読み込みしてください。");
    },
  );
}

function renderWeekLabel(weekDates) {
  if (!refs.weekLabel) {
    return;
  }
  const start = weekDates[0];
  const end = weekDates[6];
  refs.weekLabel.textContent = `${formatDateJP(start)} 〜 ${formatDateJP(end)}`;
}

function renderTable(weekDates) {
  if (!refs.scheduleTable) {
    return;
  }

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");

  const thName = document.createElement("th");
  thName.textContent = "名前（ID）";
  thName.classList.add("name-col");
  trHead.appendChild(thName);

  for (const date of weekDates) {
    const th = document.createElement("th");
    const dateStr = toISODate(date);
    const holidayName = getHolidayName(dateStr);

    const day = document.createElement("span");
    day.className = "day-label";
    day.textContent = `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAY_LABELS[date.getDay()]}）`;
    th.appendChild(day);

    if (holidayName) {
      const chip = document.createElement("span");
      chip.className = "day-holiday";
      chip.textContent = holidayName;
      th.appendChild(chip);
    }

    trHead.appendChild(th);
  }

  thead.appendChild(trHead);

  const tbody = document.createElement("tbody");
  const visibleStaff = isPersonalPage
    ? state.currentUser && state.staff.includes(state.currentUser)
      ? [state.currentUser]
      : []
    : state.staff;

  for (const name of visibleStaff) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("th");
    tdName.textContent = name;
    tr.appendChild(tdName);

    for (const date of weekDates) {
      const dateStr = toISODate(date);
      const entry = resolveEntry(name, dateStr);
      const td = document.createElement("td");
      const btn = document.createElement("button");
      const isEditable = isPersonalPage && canEditRow(name);
      const statusClass = getStatusClass(entry);

      btn.type = "button";
      btn.className = `cell-btn ${entry ? entry.source : ""} ${statusClass} ${isEditable ? "" : "readonly"}`.trim();
      btn.innerHTML = renderCellHtml(entry);

      if (isEditable) {
        btn.addEventListener("click", () => openEditDialog(name, dateStr, entry));
      } else {
        btn.disabled = true;
        btn.title = "個人入力ページで本人ログイン時のみ編集できます";
      }

      td.appendChild(btn);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  if (isPersonalPage && visibleStaff.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = weekDates.length + 1;
    td.textContent = "ログインすると自分の予定だけ表示されます。";
    td.style.textAlign = "center";
    td.style.padding = "14px";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  refs.scheduleTable.innerHTML = "";
  refs.scheduleTable.appendChild(thead);
  refs.scheduleTable.appendChild(tbody);
}

function renderCellHtml(entry) {
  if (!entry) {
    return `<div class="cell-status">-</div><div class="cell-work">未入力</div>`;
  }

  const work = entry.work || "";
  const place = entry.place || "";

  return `
    <div class="cell-status">${escapeHtml(entry.status)}</div>
    <div class="cell-work">${escapeHtml(work)}</div>
    <div class="cell-place">${escapeHtml(place)}</div>
  `;
}

function renderUserOrderList() {
  if (!refs.userOrderList || isPersonalPage || !state.isAdmin) {
    if (refs.userOrderList) {
      refs.userOrderList.innerHTML = "";
    }
    return;
  }

  refs.userOrderList.innerHTML = "";

  state.staffAccounts.forEach((account, index) => {
    const li = document.createElement("li");
    li.className = "user-order-item";

    const meta = document.createElement("div");
    meta.className = "user-order-meta";
    meta.innerHTML = `
      <strong>${escapeHtml(account.name)}</strong>
      <span>（ID: ${escapeHtml(account.id)}）</span>
      <span class="password-mask">認証: Firebase</span>
    `;

    const buttons = document.createElement("div");
    buttons.className = "order-buttons";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "btn btn-secondary order-btn";
    upBtn.textContent = "↑";
    upBtn.dataset.action = "up";
    upBtn.dataset.index = String(index);
    upBtn.disabled = index === 0;

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "btn btn-secondary order-btn";
    downBtn.textContent = "↓";
    downBtn.dataset.action = "down";
    downBtn.dataset.index = String(index);
    downBtn.disabled = index === state.staffAccounts.length - 1;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-ghost order-btn order-btn-danger";
    deleteBtn.textContent = "削除";
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.index = String(index);

    buttons.appendChild(upBtn);
    buttons.appendChild(downBtn);
    buttons.appendChild(deleteBtn);
    li.appendChild(meta);
    li.appendChild(buttons);
    refs.userOrderList.appendChild(li);
  });
}

function moveStaffAccount(index, delta) {
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || index >= state.staffAccounts.length || nextIndex >= state.staffAccounts.length) {
    return false;
  }

  const items = state.staffAccounts;
  [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
  return true;
}

function deleteManualEntriesByUserName(userName) {
  const prefix = `${userName}::`;
  for (const key of Object.keys(state.manualEntries)) {
    if (key.startsWith(prefix)) {
      delete state.manualEntries[key];
    }
  }
}

function getStatusClass(entry) {
  if (!entry || entry.source !== "manual") {
    return "";
  }

  switch (entry.status) {
    case "現場":
      return "status-genba";
    case "内業":
      return "status-naigyo";
    case "打合せ":
      return "status-meeting";
    case "移動":
      return "status-move";
    case "休み":
    case "午前休":
    case "午後休":
      return "status-off";
    case "有給":
    case "午前有":
    case "午後有":
      return "status-paid";
    default:
      return "";
  }
}

function resolveEntry(name, dateStr) {
  const manual = state.manualEntries[entryKey(name, dateStr)];
  if (manual) {
    return manual;
  }

  const date = fromISODate(dateStr);

  if (state.settings.holidayAutoEnabled) {
    const holidayName = getHolidayName(dateStr);
    if (holidayName) {
      return {
        status: "休み",
        work: `（祝日）${holidayName}`,
        place: "",
        source: "holiday",
      };
    }
  }

  if (date.getDay() === 0) {
    return {
      status: "休み",
      work: "（日曜休み）",
      place: "",
      source: "sunday",
    };
  }

  if (isCompanyHoliday(date)) {
    return {
      status: "休み",
      work: "（土曜休日）",
      place: "",
      source: "company",
    };
  }

  return null;
}

function openEditDialog(name, dateStr, currentEntry) {
  if (!isPersonalPage || !canEditRow(name) || !refs.editDialog) {
    setNotice("自分の行のみ編集できます。");
    return;
  }

  state.editTarget = { name, date: dateStr };

  const date = fromISODate(dateStr);
  if (refs.editMeta) {
    refs.editMeta.textContent = `${name} / ${formatDateJP(date)}`;
  }

  if (refs.statusInput) {
    refs.statusInput.innerHTML = STATUS_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("");
    refs.statusInput.value = currentEntry?.status || "現場";
  }
  if (refs.workInput) {
    refs.workInput.value = currentEntry?.work || "";
  }
  if (refs.placeInput) {
    refs.placeInput.value = currentEntry?.place || "";
  }
  if (refs.repeatEnabled) {
    refs.repeatEnabled.checked = false;
  }
  if (refs.repeatCount) {
    refs.repeatCount.value = "1";
  }

  refs.editDialog.showModal();
}

function saveManualEntriesWithRepeat(name, startDateStr, entryData, repeatDays) {
  const count = clamp(repeatDays, 1, 12);
  const startDate = fromISODate(startDateStr);

  for (let i = 0; i < count; i += 1) {
    const targetDate = addDays(startDate, i);
    const key = entryKey(name, toISODate(targetDate));
    state.manualEntries[key] = {
      ...entryData,
      updatedAt: new Date().toISOString(),
    };
  }

  return count;
}

function isCompanyHoliday(date) {
  if (date.getDay() !== 6) {
    return false;
  }

  const month = date.getMonth() + 1;

  if (monthInRange(month, state.settings.dullStartMonth, state.settings.dullEndMonth)) {
    return true;
  }

  if (monthInRange(month, state.settings.busyStartMonth, state.settings.busyEndMonth)) {
    const saturdayNo = getSaturdayNoInMonth(date);
    if (state.settings.biweeklyPattern === "1-3") {
      return saturdayNo === 1 || saturdayNo === 3;
    }
    return saturdayNo === 2 || saturdayNo === 4;
  }

  return false;
}

function monthInRange(month, start, end) {
  if (start <= end) {
    return month >= start && month <= end;
  }
  return month >= start || month <= end;
}

function getSaturdayNoInMonth(date) {
  const day = date.getDate();
  return Math.floor((day - 1) / 7) + 1;
}

async function ensureHolidayCache(weekDates) {
  if (!state.settings.holidayAutoEnabled) {
    return;
  }

  const years = [...new Set(weekDates.map((d) => d.getFullYear()))];
  await Promise.all(years.map((year) => loadHolidayByYear(year)));
}

async function loadHolidayByYear(year) {
  if (state.holidaysByYear[year]) {
    return;
  }

  const url = `https://holidays-jp.github.io/api/v1/${year}/date.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("祝日データを取得できませんでした。");
    }
    const data = await response.json();
    state.holidaysByYear[year] = data;
  } catch (error) {
    state.holidaysByYear[year] = {};
    setNotice(`祝日データ取得に失敗: ${year}年`);
  }
}

function getHolidayName(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  return state.holidaysByYear[year]?.[dateStr] || "";
}

function buildMonthOptions() {
  if (!refs.dullStartMonth || !refs.dullEndMonth || !refs.busyStartMonth || !refs.busyEndMonth) {
    return;
  }

  refs.dullStartMonth.innerHTML = "";
  refs.dullEndMonth.innerHTML = "";
  refs.busyStartMonth.innerHTML = "";
  refs.busyEndMonth.innerHTML = "";

  for (let m = 1; m <= 12; m += 1) {
    const appendOption = (target) => {
      const option = document.createElement("option");
      option.value = String(m);
      option.textContent = `${m}月`;
      target.appendChild(option);
    };

    appendOption(refs.dullStartMonth);
    appendOption(refs.dullEndMonth);
    appendOption(refs.busyStartMonth);
    appendOption(refs.busyEndMonth);
  }
}

function syncLoginForm() {
  if (!refs.loginIdInput || !refs.loginPasswordInput) {
    return;
  }
  refs.loginIdInput.value = state.currentUserId || "";
  refs.loginPasswordInput.value = "";
}

function syncAuthUi() {
  if (!refs.currentUserLabel) {
    return;
  }
  const userLabel = state.currentUser
    ? `${state.currentUser}（ID:${state.currentUserId || "-"}）`
    : "未ログイン";
  refs.currentUserLabel.textContent = `ログイン: ${userLabel}${state.isAdmin ? " [管理者]" : ""}`;
}

function syncAdminUi() {
  if (!isOverallPage) {
    return;
  }

  const showAdmin = Boolean(state.isAdmin);

  if (refs.adminSettingsSection) {
    refs.adminSettingsSection.classList.toggle("hidden", !showAdmin);
  }
  if (refs.adminRegisterSection) {
    refs.adminRegisterSection.classList.toggle("hidden", !showAdmin);
  }
  if (refs.adminOnlyNotice) {
    refs.adminOnlyNotice.classList.toggle("hidden", showAdmin);
  }

  if (!showAdmin && refs.settingsPanel) {
    refs.settingsPanel.classList.add("hidden");
  }
  if (!showAdmin && refs.registerPanel) {
    refs.registerPanel.classList.add("hidden");
  }
}

function canManageAdminSettings() {
  return !isOverallPage || state.isAdmin;
}

function canEditRow(name) {
  return isPersonalPage && Boolean(state.currentUser) && state.currentUser === name;
}

function syncSettingsToForm() {
  if (!refs.holidayAutoEnabled) {
    return;
  }

  refs.holidayAutoEnabled.checked = state.settings.holidayAutoEnabled;
  if (refs.dullStartMonth) {
    refs.dullStartMonth.value = String(state.settings.dullStartMonth);
  }
  if (refs.dullEndMonth) {
    refs.dullEndMonth.value = String(state.settings.dullEndMonth);
  }
  if (refs.busyStartMonth) {
    refs.busyStartMonth.value = String(state.settings.busyStartMonth);
  }
  if (refs.busyEndMonth) {
    refs.busyEndMonth.value = String(state.settings.busyEndMonth);
  }
  if (refs.biweeklyPattern) {
    refs.biweeklyPattern.value = state.settings.biweeklyPattern;
  }
}

async function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      applyLoadedData(JSON.parse(raw), true);
    } catch (error) {
      setNotice("保存データの読み込みに失敗したため初期化しました。");
    }
  }

  if (cloudSyncEnabled && currentFirebaseUser) {
    cloudLoading = true;
    try {
      const snapshot = await firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).get();
      if (snapshot.exists) {
        const cloudData = snapshot.data();
        applyLoadedData(cloudData, false);
        lastKnownRemoteUpdatedAt = normalizeTimestamp(cloudData.updatedAt);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
      }
    } catch (error) {
      setNotice("Firestore読込に失敗。ローカルデータで続行します。");
    } finally {
      cloudLoading = false;
    }
  }

  refreshStaffFromAccounts();
}

function saveState() {
  const localPayload = buildLocalPayload();
  const cloudPayload = buildCloudPayload();
  lastLocalSaveUpdatedAt = normalizeTimestamp(cloudPayload.updatedAt);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPayload));
  queueCloudSave(cloudPayload);
}

function buildLocalPayload() {
  return {
    currentWeekStart: toISODate(state.currentWeekStart),
    currentUser: state.currentUser,
    currentUserId: state.currentUserId,
    staff: state.staff,
    staffAccounts: state.staffAccounts,
    manualEntries: state.manualEntries,
    settings: state.settings,
  };
}

function buildCloudPayload() {
  return {
    currentWeekStart: toISODate(state.currentWeekStart),
    staff: state.staff,
    staffAccounts: state.staffAccounts,
    manualEntries: state.manualEntries,
    settings: state.settings,
    updatedByName: state.currentUser || (isPersonalPage ? "未ログイン利用者" : "管理画面"),
    updatedById: state.currentUserId || "",
    updatedByPage: pageMode,
    updatedAt: new Date().toISOString(),
  };
}

function applyLoadedData(data, restoreSession = true) {
  if (!data || typeof data !== "object") {
    return;
  }
  if (data.staff && Array.isArray(data.staff)) {
    state.staff = data.staff;
  }
  if (data.staffAccounts && Array.isArray(data.staffAccounts)) {
    state.staffAccounts = data.staffAccounts.map((item) => toStaffAccount(item));
  }
  if (data.manualEntries && typeof data.manualEntries === "object") {
    state.manualEntries = data.manualEntries;
  }
  if (data.settings && typeof data.settings === "object") {
    state.settings = {
      ...state.settings,
      ...data.settings,
    };
  }
  if (data.currentWeekStart) {
    state.currentWeekStart = fromISODate(data.currentWeekStart);
  }
  if (restoreSession) {
    if (data.currentUser && typeof data.currentUser === "string") {
      state.currentUser = data.currentUser;
    }
    if (data.currentUserId && typeof data.currentUserId === "string") {
      state.currentUserId = data.currentUserId;
    } else if (state.currentUser) {
      state.currentUserId = findLoginIdByUserName(state.currentUser) || "";
    }
  }
}

function queueCloudSave(payload) {
  if (!cloudSyncEnabled || cloudLoading || !currentFirebaseUser) {
    return;
  }

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
  }

  cloudSaveTimer = setTimeout(async () => {
    try {
      await firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).set(payload, { merge: true });
      lastKnownRemoteUpdatedAt = normalizeTimestamp(payload.updatedAt);
    } catch (error) {
      setNotice("Firestore保存に失敗。再度保存してください。");
    }
  }, 400);
}

function notifyRemoteUpdate(cloudData) {
  const updaterName = String(cloudData.updatedByName || "他の利用者");
  const updatedAt = normalizeTimestamp(cloudData.updatedAt);
  const timeLabel = formatTimeLabel(updatedAt);
  const message = `${updaterName} が予定を更新しました。${timeLabel}`.trim();

  showSyncAlert(message);
  setNotice(message);

  if (window.Notification && Notification.permission === "granted") {
    const body = cloudData.updatedByPage === "overall"
      ? "全体ページの内容が更新されました。"
      : "個人入力ページの内容が更新されました。";
    try {
      new Notification("週間予定表が更新されました", {
        body: `${updaterName} が更新しました。${body}`,
      });
    } catch (error) {
      // ブラウザ通知不可時は画面内通知のみ継続
    }
  }
}

function showSyncAlert(text) {
  if (!refs.syncAlert) {
    return;
  }

  refs.syncAlert.textContent = text;
  refs.syncAlert.classList.remove("hidden");

  if (syncAlertTimer) {
    clearTimeout(syncAlertTimer);
  }

  syncAlertTimer = setTimeout(() => {
    refs.syncAlert?.classList.add("hidden");
  }, 7000);
}

function syncNotificationUi() {
  if (!refs.notificationStatus || !refs.enableNotificationsBtn) {
    return;
  }

  if (!("Notification" in window)) {
    refs.notificationStatus.textContent = "端末通知: このブラウザは未対応";
    refs.enableNotificationsBtn.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    refs.notificationStatus.textContent = "端末通知: 有効";
    refs.enableNotificationsBtn.disabled = true;
    return;
  }

  if (Notification.permission === "denied") {
    refs.notificationStatus.textContent = "端末通知: ブロックされています";
    refs.enableNotificationsBtn.disabled = true;
    return;
  }

  refs.notificationStatus.textContent = "端末通知: 未設定";
  refs.enableNotificationsBtn.disabled = false;
}

async function requestBrowserNotificationPermission() {
  if (!("Notification" in window)) {
    setNotice("このブラウザでは端末通知を利用できません。");
    syncNotificationUi();
    return;
  }

  const permission = await Notification.requestPermission();
  syncNotificationUi();

  if (permission === "granted") {
    setNotice("端末通知を有効にしました。他の利用者の更新時に通知します。");
    return;
  }

  setNotice("端末通知は有効化されませんでした。画面内通知は引き続き表示されます。");
}

async function handleAuthStateChanged(user) {
  currentFirebaseUser = user;

  if (!user) {
    stopCloudListener();
    state.currentUser = "";
    state.currentUserId = "";
    state.isAdmin = false;
    state.editTarget = null;
    updatePageLock();
    syncAuthUi();
    syncAdminUi();
    syncLoginForm();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
    if (requiresAuth && refs.loginDialog) {
      refs.loginDialog.showModal();
    }
    setNotice("ログアウトしました。ログイン後に利用できます。");
    return;
  }

  const authLoginId = getLoginIdFromAuthUser(user);
  if (authLoginId) {
    state.currentUserId = authLoginId;
    const account = findAccountByLoginId(authLoginId);
    state.currentUser = account?.name || authLoginId;
  }

  state.isAdmin = await detectAdminUser(user);

  updatePageLock();
  syncAuthUi();
  syncAdminUi();
  syncLoginForm();
  if (refs.loginDialog?.open) {
    refs.loginDialog.close();
  }
  startCloudListener();
  saveState();
  const signedInLabel = state.currentUser || state.currentUserId || "利用者";
  setNotice(`${signedInLabel}${state.isAdmin ? "（管理者）" : ""}でログインしました。`);
  await render();
}

async function detectAdminUser(user) {
  if (!user || !firebaseAuth) {
    return false;
  }

  if (user.email === buildAuthEmail(ADMIN_LOGIN_ID)) {
    return true;
  }

  try {
    const tokenResult = await user.getIdTokenResult();
    return tokenResult?.claims?.admin === true;
  } catch (error) {
    return false;
  }
}

async function ensureAdminAccount(loginId, loginPassword) {
  if (!firebaseAuth || !isAdminCredential(loginId, loginPassword)) {
    return;
  }

  try {
    await firebaseAuth.signInWithEmailAndPassword(buildAuthEmail(loginId), loginPassword);
    await firebaseAuth.signOut();
    return;
  } catch (error) {
    if (!isAuthUserMissingError(error)) {
      return;
    }
  }

  await firebaseAuth.createUserWithEmailAndPassword(buildAuthEmail(ADMIN_LOGIN_ID), ADMIN_PASSWORD);
  await firebaseAuth.signOut();
}

function isAdminCredential(loginId, loginPassword) {
  return normalizeLoginId(loginId) === normalizeLoginId(ADMIN_LOGIN_ID)
    && normalizeLoginPassword(loginPassword) === normalizeLoginPassword(ADMIN_PASSWORD);
}

async function createUserWithoutSwitchingSession(email, password) {
  const config = window.__FIREBASE_CONFIG__;
  const secondaryName = `register-${Date.now()}`;
  const secondaryApp = window.firebase.initializeApp(config, secondaryName);

  try {
    const secondaryAuth = secondaryApp.auth();
    return await secondaryAuth.createUserWithEmailAndPassword(email, password);
  } finally {
    await secondaryApp.delete();
  }
}

function stopCloudListener() {
  if (cloudUnsubscribe) {
    cloudUnsubscribe();
    cloudUnsubscribe = null;
  }
}

function updatePageLock() {
  if (!requiresAuth) {
    document.body.classList.remove("auth-locked");
    return;
  }

  document.body.classList.toggle("auth-locked", !currentFirebaseUser);
}

function toStaffAccount(item) {
  const id = normalizeLoginId(item.id || item.name || "");
  return {
    id,
    name: normalizeDisplayName(item.name || item.id || ""),
    password: normalizeLoginPassword(item.password || ""),
  };
}

async function migrateLegacyAccountOnLogin(loginId, loginPassword, loginError) {
  if (!isAuthUserMissingError(loginError)) {
    return false;
  }

  const legacy = findAccountByLoginId(loginId);
  if (!legacy) {
    return false;
  }

  const legacyPassword = normalizeLoginPassword(legacy.password || "");
  if (!legacyPassword || legacyPassword !== normalizeLoginPassword(loginPassword)) {
    return false;
  }

  try {
    await firebaseAuth.createUserWithEmailAndPassword(buildAuthEmail(loginId), loginPassword);
    setNotice("旧アカウントをFirebase認証へ移行しました。再ログイン不要で続行します。");
    return true;
  } catch (migrationError) {
    if (migrationError?.code === "auth/email-already-in-use") {
      try {
        await firebaseAuth.signInWithEmailAndPassword(buildAuthEmail(loginId), loginPassword);
        return true;
      } catch (signInError) {
        return false;
      }
    }
    return false;
  }
}

function isAuthUserMissingError(error) {
  const code = error?.code || "";
  return code === "auth/user-not-found" || code === "auth/invalid-credential";
}

function buildAuthEmail(loginId) {
  return `${encodeLoginIdForEmail(loginId)}@${AUTH_EMAIL_DOMAIN}`;
}

function getLoginIdFromAuthUser(user) {
  const email = String(user?.email || "");
  if (!email.includes("@")) {
    return "";
  }

  const encoded = email.split("@")[0] || "";
  return decodeLoginIdFromEmailLocal(encoded);
}

function encodeLoginIdForEmail(value) {
  const normalized = normalizeLoginId(value);
  const bytes = new TextEncoder().encode(normalized);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeLoginIdFromEmailLocal(value) {
  if (!value) {
    return "";
  }

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return normalizeLoginId(decoded);
  } catch (error) {
    return "";
  }
}

function convertFirebaseAuthError(error) {
  const code = error?.code || "";
  switch (code) {
    case "auth/email-already-in-use":
      return "この名前(ID)はすでに登録されています。";
    case "auth/weak-password":
      return "パスワードは8桁の誕生日で入力してください。";
    case "auth/network-request-failed":
      return "通信に失敗しました。ネットワークを確認してください。";
    default:
      return "Firebase Authentication の処理に失敗しました。設定内容を確認してください。";
  }
}

function normalizeTimestamp(value) {
  return typeof value === "string" ? value : "";
}

function formatTimeLabel(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `(${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")})`;
}

function normalizeLoginId(value) {
  return String(value)
    .trim()
    .replaceAll(" ", "")
    .replaceAll("　", "");
}

function normalizeDisplayName(value) {
  return String(value).trim().replaceAll("　", " ").replace(/\s+/g, " ");
}

function normalizeLoginPassword(value) {
  return String(value).replaceAll("-", "").replaceAll("/", "").trim();
}

function maskPassword(password) {
  return "Firebase認証";
}

function findAccountByCredentials(loginId, loginPassword) {
  const normalizedId = normalizeLoginId(loginId);
  const normalizedPassword = normalizeLoginPassword(loginPassword);
  return (
    state.staffAccounts.find(
      (item) => normalizeLoginId(item.id) === normalizedId && normalizeLoginPassword(item.password) === normalizedPassword,
    ) || null
  );
}

function findAccountByLoginId(loginId) {
  const normalizedId = normalizeLoginId(loginId);
  return state.staffAccounts.find((item) => normalizeLoginId(item.id) === normalizedId) || null;
}

function findLoginIdByUserName(name) {
  const account = state.staffAccounts.find((item) => item.name === name);
  return account?.id || "";
}

function refreshStaffFromAccounts() {
  const names = state.staffAccounts.map((item) => item.name).filter((name) => Boolean(name));
  state.staff = [...new Set(names)];
}

function setNotice(text) {
  if (refs.notice) {
    refs.notice.textContent = text;
  }
}

function getMonday(baseDate) {
  const date = new Date(baseDate);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getWeekDates(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fromISODate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function entryKey(name, dateStr) {
  return `${name}::${dateStr}`;
}

function formatDateJP(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
