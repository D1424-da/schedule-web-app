const STORAGE_KEY = "weekly-schedule-v1";
const LOCAL_RECOVERY_BACKUP_INDEX_KEY = "weekly-schedule-backup-index-v1";
const LOCAL_RECOVERY_BACKUP_PREFIX = "weekly-schedule-backup-v1-";
const LOCAL_RECOVERY_BACKUP_MAX_COUNT = 20;
const SCHEDULE_NOTIFICATION_PREFERENCE_KEY = "weekly-notification-schedule-enabled-v1";
const REQUEST_NOTIFICATION_PREFERENCE_KEY = "weekly-notification-request-enabled-v1";
const PUSH_TOKEN_STORAGE_KEY = "weekly-push-token-v1";
const PUSH_TOKEN_COLLECTION = "pushTokens";

const STATUS_OPTIONS = ["現場", "内業", "打合せ", "移動", "営業", "事務", "総務", "休み", "午前休", "午後休", "有給", "午前有休", "午後有休"];
const HALF_DAY_SECONDARY_STATUS_OPTIONS = ["現場", "内業", "打合せ", "移動", "営業", "事務", "総務"];
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
const ADMIN_LOGIN_ID = "イオリ技研";
const ADMIN_LOGIN_ID_ALIASES = ["イオリ技建"];
const ADMIN_PASSWORD = "123456";
const ADMIN_AUTH_LOCAL_PART = "__admin_root_v1";
const AUTH_PROFILE_MAP_KEY = "weekly-auth-profile-map-v1";

const pageMode = document.body?.dataset?.page || "home";
const isPersonalPage = pageMode === "personal";
const isOverallPage = pageMode === "overall";
const isAdminPage = pageMode === "admin";
const requiresAuth = pageMode === "personal" || pageMode === "overall" || pageMode === "admin";
const FIRESTORE_COLLECTION = "appData";
const FIRESTORE_DOCUMENT = "weeklySchedule";

let firestoreDb = null;
let firebaseAuth = null;
let firebaseMessaging = null;
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
let pendingLoginId = "";
let pendingLoginDisplayName = "";
let pendingLoginPassword = "";
let authProfileMap = {};
let loginInFlight = false;
let loginBlockedUntil = 0;
let scheduleNotificationEnabled = true;
let requestNotificationEnabled = true;
let lastIncomingRequestSignature = "";
let tableScrollbarSyncing = false;
let monthlyScrollbarSyncing = false;
let tableScrollbarResizeBound = false;
let desktopRequestPanelEl = null;
let desktopRequestListEl = null;
let scheduleFinalizeRequired = false;
let finalizeInFlight = false;
let currentPushToken = "";
let progressEditProjectId = null;
let progressEditProjectOwnerUserId = null;
let progressEditItemProjectId = null;
let progressEditItemId = null;
let progressEditItemOwnerUserId = null;
let progressSaveTimer = null;
let lifecycleEventsBound = false;

const LOGIN_BLOCK_MS_AFTER_TOO_MANY_REQUESTS = 60 * 1000;

const state = {
  currentWeekStart: getMonday(new Date()),
  currentMonthStart: getMonthStart(new Date()),
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
  confirmationRequests: [],
  weeklyBusinessNotes: {},
  progressProjectsByUser: {},
};

function hasMeaningfulScheduleData() {
  return (
    Object.keys(state.manualEntries || {}).length > 0
    || Object.keys(state.weeklyBusinessNotes || {}).length > 0
    || Object.keys(state.progressProjectsByUser || {}).length > 0
    || (Array.isArray(state.confirmationRequests) && state.confirmationRequests.length > 0)
  );
}

function saveLocalRecoveryBackup(payload, reason = "autosave") {
  try {
    const timestamp = new Date().toISOString();
    const backupKey = `${LOCAL_RECOVERY_BACKUP_PREFIX}${timestamp}`;
    localStorage.setItem(backupKey, JSON.stringify({
      createdAt: timestamp,
      reason,
      payload,
    }));

    const rawIndex = localStorage.getItem(LOCAL_RECOVERY_BACKUP_INDEX_KEY);
    const parsedIndex = JSON.parse(rawIndex || "[]");
    const index = Array.isArray(parsedIndex) ? parsedIndex : [];
    index.push({ key: backupKey, createdAt: timestamp, reason });

    while (index.length > LOCAL_RECOVERY_BACKUP_MAX_COUNT) {
      const removed = index.shift();
      if (removed?.key) {
        localStorage.removeItem(removed.key);
      }
    }

    localStorage.setItem(LOCAL_RECOVERY_BACKUP_INDEX_KEY, JSON.stringify(index));
  } catch (error) {
    // バックアップ保存失敗時も本処理は継続
  }
}

const refs = {
  prevWeekBtn: document.getElementById("prevWeekBtn"),
  nextWeekBtn: document.getElementById("nextWeekBtn"),
  prevMonthBtn: document.getElementById("prevMonthBtn"),
  nextMonthBtn: document.getElementById("nextMonthBtn"),
  currentMonthBtn: document.getElementById("currentMonthBtn"),
  finalizeScheduleBtn: document.getElementById("finalizeScheduleBtn"),
  todayBtn: document.getElementById("todayBtn"),
  weekLabel: document.getElementById("weekLabel"),
  printDateRange: document.getElementById("printDateRange"),
  monthLabel: document.getElementById("monthLabel"),
  scheduleTable: document.getElementById("scheduleTable"),
  monthlyScheduleTable: document.getElementById("monthlyScheduleTable"),
  scheduleScrollbar: document.getElementById("scheduleScrollbar"),
  scheduleScrollbarInner: document.getElementById("scheduleScrollbarInner"),
  monthlyScrollbar: document.getElementById("monthlyScrollbar"),
  monthlyScrollbarInner: document.getElementById("monthlyScrollbarInner"),
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
  secondaryStatusRow: document.getElementById("secondaryStatusRow"),
  secondaryStatusLabel: document.getElementById("secondaryStatusLabel"),
  secondaryStatusInput: document.getElementById("secondaryStatusInput"),
  workInputLabel: document.getElementById("workInputLabel"),
  workInput: document.getElementById("workInput"),
  placeInputLabel: document.getElementById("placeInputLabel"),
  placeInput: document.getElementById("placeInput"),
  halfDayWorkHint: document.getElementById("halfDayWorkHint"),
  repeatEnabled: document.getElementById("repeatEnabled"),
  repeatCount: document.getElementById("repeatCount"),
  requestConfirmEnabled: document.getElementById("requestConfirmEnabled"),
  requestTargetInput: document.getElementById("requestTargetInput"),
  requestMessageInput: document.getElementById("requestMessageInput"),
  clearEntryBtn: document.getElementById("clearEntryBtn"),
  cancelEntryBtn: document.getElementById("cancelEntryBtn"),
  loginDialog: document.getElementById("loginDialog"),
  loginForm: document.getElementById("loginForm"),
  loginIdInput: document.getElementById("loginIdInput"),
  loginPasswordInput: document.getElementById("loginPasswordInput"),
  loginSubmitBtn: document.getElementById("loginSubmitBtn"),
  loginCancelBtn: document.getElementById("loginCancelBtn"),
  registerNameInput: document.getElementById("registerNameInput"),
  registerBirthdayInput: document.getElementById("registerBirthdayInput"),
  registerUserBtn: document.getElementById("registerUserBtn"),
  toggleRegisterBtn: document.getElementById("toggleRegisterBtn"),
  registerPanel: document.getElementById("registerPanel"),
  userOrderList: document.getElementById("userOrderList"),
  changePasswordUserSelect: document.getElementById("changePasswordUserSelect"),
  newPasswordInput: document.getElementById("newPasswordInput"),
  changePasswordBtn: document.getElementById("changePasswordBtn"),
  adminSettingsSection: document.getElementById("adminSettingsSection"),
  adminRegisterSection: document.getElementById("adminRegisterSection"),
  adminRecoverySection: document.getElementById("adminRecoverySection"),
  backupRestoreSelect: document.getElementById("backupRestoreSelect"),
  refreshBackupListBtn: document.getElementById("refreshBackupListBtn"),
  restoreBackupBtn: document.getElementById("restoreBackupBtn"),
  adminOnlyNotice: document.getElementById("adminOnlyNotice"),
  enableNotificationsBtn: document.getElementById("enableNotificationsBtn"),
  toggleScheduleNotificationsBtn: document.getElementById("toggleScheduleNotificationsBtn"),
  toggleRequestNotificationsBtn: document.getElementById("toggleRequestNotificationsBtn"),
  notificationStatus: document.getElementById("notificationStatus"),
  syncAlert: document.getElementById("syncAlert"),
  requestInboxSection: document.getElementById("requestInboxSection"),
  requestInboxList: document.getElementById("requestInboxList"),
  personalBusinessNoteSection: document.getElementById("personalBusinessNoteSection"),
  businessNoteInput: document.getElementById("businessNoteInput"),
  saveBusinessNoteBtn: document.getElementById("saveBusinessNoteBtn"),
  businessNoteMeta: document.getElementById("businessNoteMeta"),
  overallBusinessNoteSection: document.getElementById("overallBusinessNoteSection"),
  overallBusinessNoteList: document.getElementById("overallBusinessNoteList"),
  progressSection: document.getElementById("progressSection"),
  progressProjectList: document.getElementById("progressProjectList"),
  addProgressProjectBtn: document.getElementById("addProgressProjectBtn"),
  progressProjectDialog: document.getElementById("progressProjectDialog"),
  progressProjectForm: document.getElementById("progressProjectForm"),
  progressProjectDialogTitle: document.getElementById("progressProjectDialogTitle"),
  progressProjectNameInput: document.getElementById("progressProjectNameInput"),
  progressProjectLocationInput: document.getElementById("progressProjectLocationInput"),
  progressProjectStartDateInput: document.getElementById("progressProjectStartDateInput"),
  progressProjectEndDateInput: document.getElementById("progressProjectEndDateInput"),
  cancelProgressProjectBtn: document.getElementById("cancelProgressProjectBtn"),
  progressItemDialog: document.getElementById("progressItemDialog"),
  progressItemForm: document.getElementById("progressItemForm"),
  progressItemDialogTitle: document.getElementById("progressItemDialogTitle"),
  progressItemNameInput: document.getElementById("progressItemNameInput"),
  progressItemNoteInput: document.getElementById("progressItemNoteInput"),
  cancelProgressItemBtn: document.getElementById("cancelProgressItemBtn"),
};

function openDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.showModal === "function") {
    try {
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    } catch (error) {
      // showModal が例外になる環境では open 属性フォールバックを使う
    }
  }

  dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }

  dialog.removeAttribute("open");
}

init();

async function init() {
      // ユーザー削除後の状態を即時保存・画面反映
      await saveState();
      await render();
    // --- 指定ユーザーの完全削除（管理者用・一時処理） ---
    const deleteNames = ["テスト", "テスト１", "テスト2", "テスト２"];
    // 「テスト2」と「テスト２」両方対応
    for (const delName of deleteNames) {
      // staffAccounts から削除
      const idx = state.staffAccounts.findIndex(acc => acc.name === delName);
      if (idx !== -1) {
        const acc = state.staffAccounts[idx];
        const loginId = (typeof normalizeLoginId === 'function') ? normalizeLoginId(acc.id || acc.name) : (acc.id || acc.name);
        // 予定データ削除
        if (state.manualEntries) {
          Object.keys(state.manualEntries).forEach((key) => {
            if (key.startsWith(`${loginId}::`)) {
              delete state.manualEntries[key];
            }
          });
        }
        // 業務メモ削除
        if (state.weeklyBusinessNotes) {
          Object.keys(state.weeklyBusinessNotes).forEach((key) => {
            if (key.startsWith(`${loginId}::`)) {
              delete state.weeklyBusinessNotes[key];
            }
          });
        }
        // 工程管理データ削除
        if (state.progressProjectsByUser && state.progressProjectsByUser[loginId]) {
          delete state.progressProjectsByUser[loginId];
        }
        // 確認依頼データ削除
        if (Array.isArray(state.confirmationRequests)) {
          state.confirmationRequests = state.confirmationRequests.filter((req) => req.targetId !== loginId && req.requesterId !== loginId);
        }
        state.staffAccounts.splice(idx, 1);
      }
    }
    // --- 完全削除ここまで ---
  initCloudStore();
  loadAuthProfileMap();
  loadNotificationPreferences();
  await waitForInitialAuthState();
  await loadState();
  let currentUserAddedToStaff = false;

  // 初期ロード時は waitForInitialAuthState が handleAuthStateChanged を呼ばないため
  // ここで管理者判定とページアクセス制御を実行する
  if (currentFirebaseUser) {
    const cachedProfile = getAuthProfile(currentFirebaseUser);
    if (cachedProfile?.loginId) {
      state.currentUserId = normalizeLoginId(cachedProfile.loginId);
      state.currentUser = normalizeDisplayName(cachedProfile.displayName || cachedProfile.loginId);
    } else {
      const authLoginId = getLoginIdFromAuthUser(currentFirebaseUser);
      if (authLoginId) {
        state.currentUserId = authLoginId;
        const account = findAccountByLoginId(authLoginId);
        state.currentUser = account?.name || authLoginId;
      }
    }

    state.isAdmin = await detectAdminUser(currentFirebaseUser);

    // 管理者は管理者ページのみ許可
    if (state.isAdmin && !isAdminPage) {
      window.location.href = "admin.html";
      return;
    }
    // 非管理者が管理者ページに直アクセスした場合は全体ページへ
    if (!state.isAdmin && isAdminPage) {
      window.location.href = "overall.html";
      return;
    }

    currentUserAddedToStaff = ensureCurrentUserInStaffAccounts();
  } else if (isAdminPage) {
    // 管理者ページはログイン地点にしない。通常ページからログインして遷移させる。
    window.location.href = "overall.html";
    return;
  }

  state.currentWeekStart = getMonday(new Date());

  buildMonthOptions();
  syncLoginForm();
  syncAuthUi();
  syncAdminUi();
  syncSettingsToForm();
  syncNotificationUi();
  bindEvents();
  bindLifecycleEvents();
  bindPrintFitEvents();
  ensureDesktopRequestPanel();
  bindTableScrollbarSync();
  bindMonthlyScrollbarSync();
  updatePageLock();

  if (currentFirebaseUser) {
    startCloudListener();
    if (currentUserAddedToStaff && hasMeaningfulScheduleData()) {
      saveState();
    }
  }

  appReady = true;
  await render();

  if (requiresAuth && !currentFirebaseUser && refs.loginDialog) {
    openDialog(refs.loginDialog);
  }
}

function bindPrintFitEvents() {
  if (!isOverallPage || typeof window === "undefined") {
    return;
  }

  window.addEventListener("beforeprint", applyOverallPrintFitScale);
  window.addEventListener("afterprint", resetOverallPrintFitScale);
}

function applyOverallPrintFitScale() {
  const body = document.body;
  const container = document.querySelector("main.container");
  if (!body || !container || !isOverallPage) {
    return;
  }

  // A4横(297x210mm) / 余白8mm前提の印刷領域をCSS pxへ換算
  const pxPerMm = 3.7795;
  const printableWidthPx = (297 - 16) * pxPerMm;
  const printableHeightPx = (210 - 16) * pxPerMm;

  const rect = container.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    body.style.setProperty("--print-fit-scale", "1");
    return;
  }

  const widthScale = printableWidthPx / rect.width;
  const heightScale = printableHeightPx / rect.height;
  const nextScale = Math.max(0.58, Math.min(1, widthScale, heightScale));
  body.style.setProperty("--print-fit-scale", String(nextScale));
}

function resetOverallPrintFitScale() {
  if (!isOverallPage || !document.body) {
    return;
  }
  document.body.style.removeProperty("--print-fit-scale");
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

  if (refs.prevMonthBtn) {
    refs.prevMonthBtn.addEventListener("click", async () => {
      state.currentMonthStart = addMonths(state.currentMonthStart, -1);
      await render();
    });
  }

  if (refs.nextMonthBtn) {
    refs.nextMonthBtn.addEventListener("click", async () => {
      state.currentMonthStart = addMonths(state.currentMonthStart, 1);
      await render();
    });
  }

  if (refs.currentMonthBtn) {
    refs.currentMonthBtn.addEventListener("click", async () => {
      state.currentMonthStart = getMonthStart(new Date());
      await render();
    });
  }

  if (refs.finalizeScheduleBtn) {
    refs.finalizeScheduleBtn.addEventListener("click", () => {
      if (!currentFirebaseUser) {
        setNotice("ログイン後に確定通知できます。");
        return;
      }
      if (!scheduleFinalizeRequired) {
        setNotice("未確定の入力はありません。変更後に確定通知してください。");
        return;
      }
      if (finalizeInFlight) {
        return;
      }

      finalizeInFlight = true;
      syncFinalizeButtonUi();
      saveState({ announce: true });
      scheduleFinalizeRequired = false;
      finalizeInFlight = false;
      syncFinalizeButtonUi();
      setNotice("入力内容を確定し、他の利用者へ通知しました。");
    });
  }

  if (refs.saveBusinessNoteBtn && refs.businessNoteInput) {
    refs.saveBusinessNoteBtn.addEventListener("click", () => {
      const loginId = normalizeLoginId(state.currentUserId);
      if (!loginId) {
        setNotice("業務欄を保存するにはログインが必要です。");
        return;
      }

      const weekStartIso = toISODate(getMonday(new Date()));
      const key = getWeeklyBusinessNoteKey(loginId, weekStartIso);
      const text = String(refs.businessNoteInput.value || "").trim();

      if (!text) {
        delete state.weeklyBusinessNotes[key];
      } else {
        state.weeklyBusinessNotes[key] = {
          text,
          updatedAt: new Date().toISOString(),
          updatedById: loginId,
          updatedByName: state.currentUser || loginId,
        };
      }

      saveWeeklyBusinessNotesImmediately();
      renderWeeklyBusinessNotes();
      setNotice("業務欄を保存しました。全体ページへ即時反映しました。");
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
    const handler = () => {
      console.log('openLoginBtn clicked');
      openDialog(refs.loginDialog);
    };
    refs.openLoginBtn.addEventListener("click", handler);
    refs.openLoginBtn.addEventListener("touchend", (e) => {
      e.preventDefault();
      handler();
    });
  } else {
    console.warn("openLoginBtn or loginDialog not found:", {
      openLoginBtn: !!refs.openLoginBtn,
      loginDialog: !!refs.loginDialog
    });
  }

  if (refs.enableNotificationsBtn) {
    refs.enableNotificationsBtn.addEventListener("click", async () => {
      await requestBrowserNotificationPermission();
    });
  }

  if (refs.toggleScheduleNotificationsBtn) {
    refs.toggleScheduleNotificationsBtn.addEventListener("click", () => {
      if (!("Notification" in window) || Notification.permission !== "granted") {
        setNotice("先に端末通知を有効化してください。");
        return;
      }
      setScheduleNotificationEnabled(!scheduleNotificationEnabled);
      setNotice(scheduleNotificationEnabled
        ? "更新通知を有効にしました。"
        : "更新通知を無効にしました。");
    });
  }

  if (refs.toggleRequestNotificationsBtn) {
    refs.toggleRequestNotificationsBtn.addEventListener("click", () => {
      if (!("Notification" in window) || Notification.permission !== "granted") {
        setNotice("先に端末通知を有効化してください。");
        return;
      }
      setRequestNotificationEnabled(!requestNotificationEnabled);
      setNotice(requestNotificationEnabled
        ? "確認依頼通知を有効にしました。"
        : "確認依頼通知を無効にしました。");
    });
  }

  if (refs.loginForm && refs.loginIdInput && refs.loginPasswordInput) {
    refs.loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const loginId = normalizeLoginId(refs.loginIdInput.value);
      const loginPassword = normalizeLoginPassword(refs.loginPasswordInput.value);
      if (!loginId) {
        setNotice("IDを入力してください。");
        refs.loginIdInput.focus();
        return;
      }
      if (!loginPassword) {
        setNotice("パスワードを入力してください。");
        refs.loginPasswordInput.focus();
        return;
      }
      if (!firebaseAuth) {
        handleLoginFailure("Firebase Authentication の設定が未完了です。");
        return;
      }

      if (isAdminLoginId(loginId) && !isAdminCredential(loginId, loginPassword)) {
        handleLoginFailure("管理者IDのパスワードが正しくありません。");
        return;
      }

      if (loginInFlight) {
        return;
      }

      const blockedRemainingMs = loginBlockedUntil - Date.now();
      if (blockedRemainingMs > 0) {
        const waitSec = Math.ceil(blockedRemainingMs / 1000);
        setNotice(`ログイン待機中です。${waitSec}秒後に再試行してください。`);
        return;
      }

      state.currentUser = normalizeDisplayName(refs.loginIdInput.value);
      state.currentUserId = loginId;
      pendingLoginId = loginId;
      pendingLoginDisplayName = state.currentUser;
      pendingLoginPassword = loginPassword;

      loginInFlight = true;
      setLoginUiBusy(true);
      try {
        await ensureAdminAccount(loginId, loginPassword);
        await signInWithLoginId(loginId, loginPassword);
      } catch (error) {
        if (error?.code === "auth/too-many-requests") {
          loginBlockedUntil = Date.now() + LOGIN_BLOCK_MS_AFTER_TOO_MANY_REQUESTS;
        }

        const migrated = await migrateLegacyAccountOnLogin(loginId, loginPassword, error);
        if (!migrated) {
          console.warn("signInWithEmailAndPassword failed", {
            code: error?.code || "",
            message: error?.message || "",
          });
          handleLoginFailure(convertFirebaseAuthError(error));
        }
      } finally {
        loginInFlight = false;
        setLoginUiBusy(false);
      }
    });
  }

  if (refs.logoutBtn) {
    refs.logoutBtn.addEventListener("click", async () => {
      if (!firebaseAuth) {
        return;
      }

      // ログアウト直前に即時保存し、遅延キュー未送信による取りこぼしを防ぐ
      try {
        await saveStateImmediately();
      } catch (error) {
        // 保存失敗時もログアウト操作は継続する
      }

      await firebaseAuth.signOut();
    });
  }

  if (refs.loginCancelBtn && refs.loginDialog) {
    refs.loginCancelBtn.addEventListener("click", () => {
      closeDialog(refs.loginDialog);
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
      const registerPassword = normalizeLoginPassword(refs.registerBirthdayInput.value);

      if (!displayName) {
        setNotice("名前（ID）を入力してください。");
        return;
      }
      if (!/^\d{8}$/.test(registerPassword)) {
        setNotice("パスワードは任意の8桁の数字で入力してください。");
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
          await firebaseAuth.createUserWithEmailAndPassword(buildAuthEmail(loginId), registerPassword);
        } else {
          await createUserWithoutSwitchingSession(buildAuthEmail(loginId), registerPassword);
        }

        state.staffAccounts.push(toStaffAccount({ id: loginId, name: displayName }));
        const createdAccount = findAccountByLoginId(loginId);
        if (createdAccount) {
          createdAccount.password = registerPassword;
        }
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

  if (refs.changePasswordBtn && refs.changePasswordUserSelect && refs.newPasswordInput) {
    refs.changePasswordBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings() || !state.isAdmin) {
        setNotice("管理者のみ操作できます。");
        return;
      }

      const targetId = normalizeLoginId(refs.changePasswordUserSelect.value);
      const newPassword = normalizeLoginPassword(refs.newPasswordInput.value);

      if (!targetId) {
        setNotice("対象利用者を選択してください。");
        return;
      }
      if (!/^\d{8}$/.test(newPassword)) {
        setNotice("新しいパスワードは任意の8桁の数字で入力してください。");
        return;
      }
      if (!firebaseAuth) {
        setNotice("Firebase Authentication の設定が未完了です。");
        return;
      }

      const targetAccount = findAccountByLoginId(targetId);
      if (!targetAccount) {
        setNotice("対象利用者が見つかりません。");
        return;
      }
      const currentPassword = normalizeLoginPassword(targetAccount.password || "");
      if (!currentPassword) {
        setNotice("対象利用者の現行パスワード情報が未登録のため変更できません。利用者本人で一度ログイン後に再実行してください。");
        return;
      }
      if (currentPassword === newPassword) {
        setNotice("新しいパスワードは前のパスワードと別にしてください。");
        return;
      }
      const targetName = targetAccount?.name || targetId;

      try {
        await changeUserPasswordWithoutSwitchingSession(targetId, currentPassword, newPassword);
        targetAccount.password = newPassword;
        saveState();
        refs.newPasswordInput.value = "";
        setNotice(`${targetName} のパスワードを変更しました。`);
      } catch (error) {
        const code = error?.code || "";
        if (
          code === "auth/wrong-password"
          || code === "auth/invalid-login-credentials"
          || code === "auth/invalid-credential"
          || code === "auth/user-not-found"
        ) {
          setNotice("管理データ上の現行パスワードと一致せず変更できません。対象利用者に再ログインしてもらってから再実行してください。");
          return;
        }
        if (code === "auth/weak-password") {
          setNotice("新しいパスワードは任意の8桁の数字で入力してください。");
          return;
        }
        setNotice(convertFirebaseAuthError(error));
      }
    });
  }

  if (refs.refreshBackupListBtn) {
    refs.refreshBackupListBtn.addEventListener("click", () => {
      if (!canManageAdminSettings() || !state.isAdmin) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      renderBackupRestoreOptions();
      setNotice("バックアップ一覧を更新しました。");
    });
  }

  if (refs.restoreBackupBtn) {
    refs.restoreBackupBtn.addEventListener("click", async () => {
      if (!canManageAdminSettings() || !state.isAdmin) {
        setNotice("管理者のみ操作できます。");
        return;
      }
      if (!refs.backupRestoreSelect) {
        return;
      }

      const backupKey = String(refs.backupRestoreSelect.value || "").trim();
      if (!backupKey) {
        setNotice("復元するバックアップを選択してください。");
        return;
      }

      const backup = getLocalRecoveryBackupByKey(backupKey);
      if (!backup?.payload) {
        setNotice("選択したバックアップが見つかりません。一覧を更新して再実行してください。");
        return;
      }

      const summary = backup?.createdAt
        ? `作成日時: ${formatDateTimeLabel(backup.createdAt)}`
        : "作成日時: 不明";
      const ok = confirm(`バックアップを復元します。\n${summary}\n現在データは上書きされます。よろしいですか？`);
      if (!ok) {
        return;
      }

      applyLoadedData(backup.payload, false);
      refreshStaffFromAccounts();
      syncCurrentUserFromLoginId();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
      await saveStateImmediately({ forceCloud: true });
      renderBackupRestoreOptions();
      await render();
      setNotice("バックアップを復元しました。全体データへ反映済みです。");
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

      if (action === "edit-name") {
        const targetAccount = state.staffAccounts[index];
        if (!targetAccount) {
          return;
        }

        const nextNameRaw = prompt("新しい表示名を入力してください", targetAccount.name);
        if (nextNameRaw === null) {
          return;
        }

        const nextName = normalizeDisplayName(nextNameRaw);
        if (!nextName) {
          setNotice("名前を入力してください。");
          return;
        }
        if (nextName === targetAccount.name) {
          return;
        }
        if (state.staffAccounts.some((account, i) => i !== index && account.name === nextName)) {
          setNotice("同じ表示名はすでに存在します。");
          return;
        }

        const prevName = targetAccount.name;
        targetAccount.name = nextName;
        renameManualEntriesByUserName(prevName, nextName);

        if (state.currentUser === prevName) {
          state.currentUser = nextName;
        }

        refreshStaffFromAccounts();
        saveState();
        setNotice(`表示名を ${prevName} から ${nextName} に変更しました。`);
        await render();
        return;
      }

      if (action === "delete") {
        const targetAccount = state.staffAccounts[index];
        if (!targetAccount) {
          return;
        }

        const ok = confirm(`${targetAccount.name} を削除します。\nこのユーザーの予定・業務メモ・工程管理データも全て削除されます。\nよろしいですか？`);
        if (!ok) {
          return;
        }

        // ユーザーID取得
        const loginId = normalizeLoginId(targetAccount.id || targetAccount.name);

        // 予定データ削除
        if (state.manualEntries) {
          Object.keys(state.manualEntries).forEach((key) => {
            if (key.startsWith(`${loginId}::`)) {
              delete state.manualEntries[key];
            }
          });
        }
        // 業務メモ削除
        if (state.weeklyBusinessNotes) {
          Object.keys(state.weeklyBusinessNotes).forEach((key) => {
            if (key.startsWith(`${loginId}::`)) {
              delete state.weeklyBusinessNotes[key];
            }
          });
        }
        // 工程管理データ削除
        if (state.progressProjectsByUser && state.progressProjectsByUser[loginId]) {
          delete state.progressProjectsByUser[loginId];
        }
        // 確認依頼データ削除（該当ユーザーが関係するものを全て削除）
        if (Array.isArray(state.confirmationRequests)) {
          state.confirmationRequests = state.confirmationRequests.filter((req) => req.targetId !== loginId && req.requesterId !== loginId);
        }

        state.staffAccounts.splice(index, 1);

        if (state.currentUser === targetAccount.name) {
          state.currentUser = "";
          state.currentUserId = "";
        }

        refreshStaffFromAccounts();
        saveState();
        setNotice(`${targetAccount.name} を削除しました。関連データも全て削除されました。`);
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
        setNotice("本人の行、または管理者として編集できます。");
        return;
      }

      const entryData = {
        status: refs.statusInput?.value || "現場",
        secondaryStatus: "",
        work: refs.workInput?.value.trim() || "",
        place: refs.placeInput?.value.trim() || "",
        source: "manual",
        updatedAt: new Date().toISOString(),
      };

      if (getHalfDayWorkingSlot(entryData.status)) {
        const secondaryStatus = String(refs.secondaryStatusInput?.value || "").trim();
        if (!secondaryStatus) {
          setNotice("半日休ステータス時は、もう半日の状態を選択してください。");
          return;
        }
        entryData.secondaryStatus = secondaryStatus;
      }

      const repeatDays = refs.repeatEnabled?.checked ? Number(refs.repeatCount?.value || 1) : 1;
      const requiresConfirmation = Boolean(refs.requestConfirmEnabled?.checked);

      if (requiresConfirmation) {
        const requesterId = normalizeLoginId(state.currentUserId);
        const requesterName = normalizeDisplayName(state.currentUser || requesterId);
        const targetIds = getSelectedRequestTargetIds();

        if (!requesterId) {
          setNotice("確認依頼を送るにはログインが必要です。");
          return;
        }

        const targets = targetIds
          .map((targetId) => ({
            targetId,
            targetAccount: findAccountByLoginId(targetId),
          }))
          .filter((item) => Boolean(item.targetId) && Boolean(item.targetAccount) && item.targetId !== requesterId);

        if (targets.length === 0) {
          setNotice("確認相手を1人以上選択してください。");
          return;
        }

        const message = normalizeDisplayName(refs.requestMessageInput?.value || "");
        const createdRequests = targets.map(({ targetId, targetAccount }) => ({
          id: createRequestId(),
          status: "pending",
          createdAt: new Date().toISOString(),
          requesterId,
          requesterName,
          targetId,
          targetName: targetAccount.name,
          ownerName: state.editTarget.name,
          startDate: state.editTarget.date,
          repeatDays: clamp(repeatDays, 1, 12),
          entryData,
          message,
        }));

        createdRequests.forEach((request) => {
          state.confirmationRequests.push(request);
        });

        trimResolvedRequests();
        saveState();
        createdRequests.forEach((request) => {
          triggerServerPushForConfirmationRequest(request);
        });
        closeDialog(refs.editDialog);
        setNotice(`${createdRequests.length}人に確認依頼を送りました。承認後に予定へ反映されます。`);
        await render();
        return;
      }

      const existingEntry = state.manualEntries[entryKey(state.editTarget.name, state.editTarget.date)];
      if (existingEntry?.approvedByRequest) {
        const ok = confirm("確認変更済みの予定です。変更しますか？");
        if (!ok) {
          return;
        }
      }

      const savedCount = saveManualEntriesWithRepeat(state.editTarget.name, state.editTarget.date, entryData, repeatDays);
      saveState();
      closeDialog(refs.editDialog);
      setNotice(`予定を保存しました。${savedCount}件反映`);
      await render();
    });
  }

  if (refs.statusInput) {
    refs.statusInput.addEventListener("change", () => {
      const status = refs.statusInput?.value || "";
      syncHalfDayInputUi(status);
      syncHalfDaySecondaryStatusUi(status);
    });
  }

  if (refs.clearEntryBtn) {
      refs.clearEntryBtn.addEventListener("click", async () => {
        if (!state.editTarget) {
          return;
        }
        if (!canEditRow(state.editTarget.name)) {
          setNotice("本人の行、または管理者として編集できます。");
          return;
        }
  
      const key = entryKey(state.editTarget.name, state.editTarget.date);
      if (state.manualEntries[key]?.approvedByRequest) {
        const ok = confirm("確認変更済みの予定です。変更しますか？");
        if (!ok) {
          return;
        }
      }

      delete state.manualEntries[key];
      markScheduleNeedsFinalize();
      saveState();
      closeDialog(refs.editDialog);
      setNotice("手動入力を解除しました。");
      await render();
    });
  }

  if (refs.cancelEntryBtn) {
    refs.cancelEntryBtn.addEventListener("click", () => {
      closeDialog(refs.editDialog);
    });
  }

  if (refs.requestConfirmEnabled) {
    refs.requestConfirmEnabled.addEventListener("change", () => {
      syncRequestFormUi();
    });
  }

  if (refs.requestInboxList) {
    refs.requestInboxList.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-request-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.requestAction;
      const requestId = String(button.dataset.requestId || "");
      if (!requestId || !action) {
        return;
      }

      await handleConfirmationRequestAction(requestId, action);
    });
  }

  if (refs.addProgressProjectBtn) {
    refs.addProgressProjectBtn.addEventListener("click", () => {
      progressEditProjectOwnerUserId = normalizeLoginId(state.currentUserId);
      openProgressProjectDialog(null);
    });
  }

  if (refs.cancelProgressProjectBtn) {
    refs.cancelProgressProjectBtn.addEventListener("click", () => {
      closeDialog(refs.progressProjectDialog);
    });
  }

  if (refs.progressProjectForm) {
    refs.progressProjectForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveProgressProject();
    });
  }

  if (refs.cancelProgressItemBtn) {
    refs.cancelProgressItemBtn.addEventListener("click", () => {
      closeDialog(refs.progressItemDialog);
    });
  }

  if (refs.progressItemForm) {
    refs.progressItemForm.addEventListener("submit", (e) => {
      e.preventDefault();
      saveProgressItem();
    });
  }

  if (refs.progressProjectList) {
    refs.progressProjectList.addEventListener("click", handleProgressListClick);
    refs.progressProjectList.addEventListener("change", handleProgressListChange);
    
    // 数字入力フィールドでEnterキーを押すとタブが閉じるのを防ぐ
    refs.progressProjectList.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.classList.contains("progress-pct-input")) {
        event.preventDefault();
        event.stopPropagation();
        // Enterで自動保存されるようにchange イベントをディスパッチ
        event.target.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, true);
  }
}

function bindLifecycleEvents() {
  if (lifecycleEventsBound || typeof window === "undefined") {
    return;
  }

  lifecycleEventsBound = true;

  const flushOnLeave = () => {
    if (!currentFirebaseUser) {
      return;
    }

    saveStateImmediately().catch(() => {
      // ページ離脱時の失敗は UI 通知できないため無視
    });
  };

  window.addEventListener("pagehide", flushOnLeave);

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushOnLeave();
      }
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
  if (window.firebase.messaging) {
    try {
      firebaseMessaging = window.firebase.messaging();
    } catch (error) {
      firebaseMessaging = null;
    }
  }
  cloudSyncEnabled = true;
}

function waitForInitialAuthState() {
  if (!firebaseAuth) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    firebaseAuth.onAuthStateChanged(async (user) => {
      currentFirebaseUser = user;
      await handleAuthStateChanged(user);
      if (!authObserverReady) {
        authObserverReady = true;
        resolve();
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
  renderWeeklyBusinessNotes();
  renderProgressSection();
  renderMonthlyCalendar();
  renderUserOrderList();
  renderPasswordChangeUserOptions();
  renderBackupRestoreOptions();
  renderRequestInbox();
  renderDesktopRequestPanel();
  syncFinalizeButtonUi();
}

function getLocalRecoveryBackupIndex() {
  try {
    const raw = localStorage.getItem(LOCAL_RECOVERY_BACKUP_INDEX_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item && typeof item.key === "string");
  } catch (error) {
    return [];
  }
}

function getLocalRecoveryBackupByKey(backupKey) {
  if (!backupKey) {
    return null;
  }

  try {
    const raw = localStorage.getItem(backupKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function renderBackupRestoreOptions() {
  if (!refs.backupRestoreSelect) {
    return;
  }

  const previousValue = refs.backupRestoreSelect.value;
  const list = getLocalRecoveryBackupIndex().slice().reverse();
  const options = ["<option value=\"\">バックアップを選択してください</option>"];

  for (const item of list) {
    const backup = getLocalRecoveryBackupByKey(item.key);
    if (!backup?.payload) {
      continue;
    }

    const createdAt = backup.createdAt || item.createdAt || "";
    const reason = backup.reason || item.reason || "save";
    const label = createdAt
      ? `${formatDateTimeLabel(createdAt)} / ${reason}`
      : `日時不明 / ${reason}`;
    options.push(`<option value="${escapeHtml(item.key)}">${escapeHtml(label)}</option>`);
  }

  refs.backupRestoreSelect.innerHTML = options.join("");
  if (previousValue && Array.from(refs.backupRestoreSelect.options).some((option) => option.value === previousValue)) {
    refs.backupRestoreSelect.value = previousValue;
  }

  if (refs.restoreBackupBtn) {
    refs.restoreBackupBtn.disabled = list.length === 0;
  }
}

function renderWeeklyBusinessNotes() {
  const weekStartIso = toISODate(getMonday(new Date()));

  if (isPersonalPage && refs.personalBusinessNoteSection && refs.businessNoteInput) {
    const loginId = normalizeLoginId(state.currentUserId);
    const key = getWeeklyBusinessNoteKey(loginId, weekStartIso);
    const note = state.weeklyBusinessNotes[key];
    refs.personalBusinessNoteSection.classList.remove("hidden");
    refs.businessNoteInput.value = note?.text || "";
    if (refs.businessNoteMeta) {
      refs.businessNoteMeta.textContent = note?.updatedAt
        ? `最終更新: ${formatDateTimeLabel(note.updatedAt)} / 保存すると全体ページへ即時反映されます。`
        : "保存すると全体ページへ即時反映されます。";
    }
  }

  if (isOverallPage && refs.overallBusinessNoteSection && refs.overallBusinessNoteList) {
    const visibleNotes = [];
    for (const account of state.staffAccounts) {
      const loginId = normalizeLoginId(account.id);
      if (!loginId) {
        continue;
      }
      const key = getWeeklyBusinessNoteKey(loginId, weekStartIso);
      const note = state.weeklyBusinessNotes[key];
      const text = String(note?.text || "").trim();
      if (!text) {
        continue;
      }
      visibleNotes.push({ account, note, text });
    }

    if (visibleNotes.length === 0) {
      refs.overallBusinessNoteSection.classList.add("hidden");
      refs.overallBusinessNoteList.innerHTML = "";
      return;
    }

    refs.overallBusinessNoteSection.classList.remove("hidden");
    const lines = [];

    for (const { account, note, text } of visibleNotes) {

      lines.push(`
        <li class="business-note-item">
          <div class="business-note-name">${escapeHtml(account.name)}</div>
          <div class="business-note-text">${escapeHtml(text)}</div>
          <div class="request-item-meta">${note?.updatedAt ? `最終更新: ${escapeHtml(formatDateTimeLabel(note.updatedAt))}` : ""}</div>
        </li>
      `);
    }

    refs.overallBusinessNoteList.innerHTML = lines.join("");
  }
}

function getWeeklyBusinessNoteKey(loginId, weekStartIso) {
  return `${normalizeLoginId(loginId)}::${weekStartIso}`;
}

// ─── 工程管理 ────────────────────────────────────────────

function generateProgressId() {
  return `prog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 現在ログイン中ユーザーの projects 配列を返す（なければ空配列） */
function getMyProjects() {
  const uid = state.currentUserId;
  if (!uid) return [];
  const entry = (state.progressProjectsByUser || {})[uid];
  return Array.isArray(entry?.projects) ? entry.projects : [];
}

function getProjectsByUserId(userId) {
  const normalizedUserId = normalizeLoginId(userId);
  if (!normalizedUserId) {
    return [];
  }
  const entry = (state.progressProjectsByUser || {})[normalizedUserId];
  return Array.isArray(entry?.projects) ? entry.projects : [];
}

function ensureProjectsEntryByUserId(userId) {
  const normalizedUserId = normalizeLoginId(userId);
  if (!normalizedUserId) {
    return null;
  }
  if (!state.progressProjectsByUser) state.progressProjectsByUser = {};
  if (!state.progressProjectsByUser[normalizedUserId]) {
    const account = findAccountByLoginId(normalizedUserId);
    state.progressProjectsByUser[normalizedUserId] = {
      userName: account?.name || normalizedUserId,
      projects: [],
    };
  }
  if (!state.progressProjectsByUser[normalizedUserId].userName) {
    const account = findAccountByLoginId(normalizedUserId);
    state.progressProjectsByUser[normalizedUserId].userName = account?.name || normalizedUserId;
  }
  return state.progressProjectsByUser[normalizedUserId];
}

function canManageProgressOwner(ownerUserId) {
  if (!currentFirebaseUser) {
    return false;
  }
  const normalizedOwnerId = normalizeLoginId(ownerUserId);
  if (!normalizedOwnerId) {
    return false;
  }
  if (isAdminPage && state.isAdmin) {
    return true;
  }
  return normalizedOwnerId === normalizeLoginId(state.currentUserId);
}

/** 現在ユーザーのエントリを初期化して返す。未ログインなら null */
function ensureMyProjectsEntry() {
  const uid = state.currentUserId;
  if (!uid) return null;
  const entry = ensureProjectsEntryByUserId(uid);
  if (entry) {
    entry.userName = state.currentUser || uid;
  }
  return entry;
}

/** 納品予定日から本日までの残り日数を計算。マイナスなら期限超過 */
function calculateDaysRemaining(endDateStr) {
  if (!endDateStr) return null;
  const endDate = new Date(endDateStr);
  if (isNaN(endDate.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  endDate.setHours(0, 0, 0, 0);
  const diffTime = endDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

/** projects 配列を HTML 文字列に変換する。isOwner=true のときのみ編集ボタンを表示 */
function renderProgressProjectCards(projects, ownerUserId) {
  const canManage = canManageProgressOwner(ownerUserId);
  const isOverallPage = document.body.dataset.page === "overall";

  return projects.map((project) => {
    const isDelivered = project?.deliveryStatus === "delivered";
    const items = Array.isArray(project.items) ? project.items : [];
    const avgProgress = items.length > 0
      ? Math.round(items.reduce((sum, item) => sum + clamp(Number(item.progress || 0), 0, 100), 0) / items.length)
      : 0;

    const daysRemaining = calculateDaysRemaining(project.endDate);
    let daysRemainingDisplay = "";
    if (daysRemaining !== null) {
      if (daysRemaining < 0) {
        daysRemainingDisplay = `<span class="progress-deadline-status deadline-overdue">期限超過 ${Math.abs(daysRemaining)}日</span>`;
      } else if (daysRemaining === 0) {
        daysRemainingDisplay = `<span class="progress-deadline-status deadline-today">本日納品</span>`;
      } else if (daysRemaining <= 7) {
        daysRemainingDisplay = `<span class="progress-deadline-status deadline-urgent">あと ${daysRemaining}日</span>`;
      } else {
        daysRemainingDisplay = `<span class="progress-deadline-status deadline-normal">あと ${daysRemaining}日</span>`;
      }
    }

    return `
      <div class="progress-project-card${isDelivered ? " is-delivered" : ""}" data-project-id="${escapeHtml(project.id)}" data-user-id="${escapeHtml(ownerUserId)}" data-expanded="false">
        <div class="progress-project-header" data-progress-action="toggle-items" data-project-id="${escapeHtml(project.id)}" role="button" tabindex="0">
          <div class="progress-project-title">
            <span class="progress-project-toggle">▶</span>
            <span class="progress-project-name">${escapeHtml(project.name)}</span>
            ${project.location ? `<span class="progress-project-location">${escapeHtml(project.location)}</span>` : ""}
          </div>
          <div class="progress-project-summary">
            <span class="progress-overall-label">全体進捗 ${avgProgress}%</span>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill" style="width:${avgProgress}%"></div>
            </div>
            ${isDelivered ? '<span class="progress-deadline-status deadline-delivered">納品済み</span>' : ""}
            ${daysRemainingDisplay}
            ${project.endDate ? `<span class="progress-deadline-date">${project.endDate} 納品</span>` : ""}
          </div>
          ${canManage && !isOverallPage ? `
            <div class="progress-project-actions no-print">
              <button class="btn ${isDelivered ? "btn-secondary" : "btn"}" type="button" data-progress-action="toggle-delivered" data-project-id="${escapeHtml(project.id)}" data-user-id="${escapeHtml(ownerUserId)}">${isDelivered ? "納品完了を取り消す" : "納品完了"}</button>
              <button class="btn btn-secondary" type="button" data-progress-action="add-item" data-project-id="${escapeHtml(project.id)}" data-user-id="${escapeHtml(ownerUserId)}">＋ 工種追加</button>
              <button class="btn btn-ghost" type="button" data-progress-action="edit-project" data-project-id="${escapeHtml(project.id)}" data-user-id="${escapeHtml(ownerUserId)}">編集</button>
              <button class="btn btn-ghost" type="button" data-progress-action="delete-project" data-project-id="${escapeHtml(project.id)}" data-user-id="${escapeHtml(ownerUserId)}">削除</button>
            </div>
          ` : ""}
        </div>
        ${items.length > 0 ? `
          <div class="progress-items-container" style="display: none;">
            <table class="progress-item-table">
              <thead>
                <tr>
                  <th>工種名</th>
                  <th>進捗</th>
                  <th>状態</th>
                  <th class="no-print">備考</th>
                  <th class="no-print">更新者</th>
                  ${canManage && !isOverallPage ? '<th class="no-print"></th>' : ""}
                </tr>
              </thead>
              <tbody>
                ${items.map((item) => {
                  const progress = clamp(Number(item.progress || 0), 0, 100);
                  const status = progress <= 0 ? "未着手" : progress >= 100 ? "完了" : "進行中";
                  return `
                    <tr>
                      <td class="progress-item-name-cell">${escapeHtml(item.name)}</td>
                      <td class="progress-item-cell">
                        <div class="progress-bar-wrap progress-bar-wrap-wide">
                          <div class="progress-bar-fill" style="width:${progress}%"></div>
                        </div>
                        ${canManage && !isOverallPage ? `
                          <div class="progress-input-row no-print">
                            <div class="progress-input-controls">
                              <button type="button" class="progress-decrement-btn" data-progress-action="decrement" data-project-id="${escapeHtml(project.id)}" data-item-id="${escapeHtml(item.id)}" data-user-id="${escapeHtml(ownerUserId)}" aria-label="進捗を減らす">−</button>
                              <input class="progress-pct-input" type="number" min="0" max="100" value="${progress}"
                                id="progress-pct-${escapeHtml(project.id)}-${escapeHtml(item.id)}"
                                name="progress-pct-${escapeHtml(item.id)}"
                                data-progress-action="update-progress"
                                data-project-id="${escapeHtml(project.id)}"
                                data-item-id="${escapeHtml(item.id)}"
                                data-user-id="${escapeHtml(ownerUserId)}" />
                              <button type="button" class="progress-increment-btn" data-progress-action="increment" data-project-id="${escapeHtml(project.id)}" data-item-id="${escapeHtml(item.id)}" data-user-id="${escapeHtml(ownerUserId)}" aria-label="進捗を増やす">＋</button>
                            </div>
                            <span>%</span>
                          </div>
                        ` : `<span class="no-print">${progress}%</span>`}
                        <span class="print-only">${progress}%</span>
                      </td>
                      <td><span class="progress-badge progress-badge-${status}">${status}</span></td>
                      <td class="no-print progress-note-cell">${item.note ? escapeHtml(item.note) : ""}</td>
                      <td class="no-print progress-meta-cell">${item.updatedByName ? escapeHtml(item.updatedByName) : ""}</td>
                      ${canManage && !isOverallPage ? `
                        <td class="no-print progress-action-cell">
                          <button class="btn btn-ghost" type="button" data-progress-action="edit-item" data-project-id="${escapeHtml(project.id)}" data-item-id="${escapeHtml(item.id)}" data-user-id="${escapeHtml(ownerUserId)}">編集</button>
                          <button class="btn btn-ghost" type="button" data-progress-action="delete-item" data-project-id="${escapeHtml(project.id)}" data-item-id="${escapeHtml(item.id)}" data-user-id="${escapeHtml(ownerUserId)}">削除</button>
                        </td>
                      ` : ""}
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        ` : `<p class="subtitle-mini no-print" style="display: none;">${canManage ? "「＋ 工種追加」ボタンで工種を登録してください。" : "工種が登録されていません。"}</p>`}
      </div>
    `;
  }).join("");
}

function getProgressCardDomKey(projectId, userId) {
  return `${String(userId || "")}::${String(projectId || "")}`;
}

function collectExpandedProgressCardKeys(container) {
  if (!container) {
    return new Set();
  }

  const expandedKeys = new Set();
  const expandedCards = container.querySelectorAll(".progress-project-card[data-expanded='true']");
  expandedCards.forEach((card) => {
    const projectId = String(card.getAttribute("data-project-id") || "");
    const userId = String(card.getAttribute("data-user-id") || "");
    if (projectId && userId) {
      expandedKeys.add(getProgressCardDomKey(projectId, userId));
    }
  });
  return expandedKeys;
}

function restoreExpandedProgressCards(container, expandedKeys) {
  if (!container || !expandedKeys || expandedKeys.size === 0) {
    return;
  }

  const cards = container.querySelectorAll(".progress-project-card");
  cards.forEach((card) => {
    const projectId = String(card.getAttribute("data-project-id") || "");
    const userId = String(card.getAttribute("data-user-id") || "");
    const key = getProgressCardDomKey(projectId, userId);
    if (!expandedKeys.has(key)) {
      return;
    }

    card.dataset.expanded = "true";
    const containerEl = card.querySelector(".progress-items-container");
    const emptyMsg = card.querySelector(".progress-items-container ~ .subtitle-mini");
    const toggle = card.querySelector(".progress-project-toggle");

    if (containerEl) {
      containerEl.style.display = "block";
    }
    if (emptyMsg && emptyMsg.parentElement === card) {
      emptyMsg.style.display = "block";
    }
    if (toggle) {
      toggle.textContent = "▼";
    }
  });
}

function restoreProgressInputFocus(projectId, itemId) {
  if (!refs.progressProjectList || !projectId || !itemId) {
    return;
  }

  const targetInput = Array.from(refs.progressProjectList.querySelectorAll(".progress-pct-input"))
    .find((el) => el instanceof HTMLInputElement
      && String(el.dataset.projectId || "") === String(projectId)
      && String(el.dataset.itemId || "") === String(itemId));

  if (!(targetInput instanceof HTMLInputElement)) {
    return;
  }

  const caretPos = targetInput.value.length;
  try {
    targetInput.focus({ preventScroll: true });
  } catch (error) {
    targetInput.focus();
  }

  try {
    targetInput.setSelectionRange(caretPos, caretPos);
  } catch (error) {
    // 一部環境では setSelectionRange 非対応
  }
}

function renderProgressSection() {
  if (!refs.progressSection || !refs.progressProjectList) {
    return;
  }

  const expandedKeys = collectExpandedProgressCardKeys(refs.progressProjectList);

  // 全体ページでは「現場を追加」ボタンを表示しない
  if (refs.addProgressProjectBtn) {
    refs.addProgressProjectBtn.classList.toggle("hidden", !currentFirebaseUser || isOverallPage);
  }

  if (isOverallPage || isAdminPage) {
    const byUser = state.progressProjectsByUser || {};
    const userIds = Object.keys(byUser).filter((uid) => {
      const entry = byUser[uid];
      return Array.isArray(entry?.projects) && entry.projects.length > 0;
    });

    if (userIds.length === 0) {
      refs.progressProjectList.innerHTML = '<p class="subtitle-mini">工程データがありません。</p>';
      return;
    }

    refs.progressProjectList.innerHTML = userIds.map((uid) => {
      const entry = byUser[uid];
      const projects = Array.isArray(entry?.projects) ? entry.projects : [];
      const userName = entry?.userName || uid;
      return `
        <div class="progress-user-section">
          <h3 class="progress-user-heading">${escapeHtml(userName)}</h3>
          ${renderProgressProjectCards(projects, uid)}
        </div>
      `;
    }).join("");
    restoreExpandedProgressCards(refs.progressProjectList, expandedKeys);
    return;
  }

  // 個人ページ：自分のプロジェクトのみ表示
  const myUid = state.currentUserId || "";
  const projects = getMyProjects();
  if (projects.length === 0) {
    refs.progressProjectList.innerHTML = '<p class="subtitle-mini">工程データがありません。「＋ 現場を追加」から登録してください。</p>';
    return;
  }
  refs.progressProjectList.innerHTML = renderProgressProjectCards(projects, myUid);
  restoreExpandedProgressCards(refs.progressProjectList, expandedKeys);
}

function openProgressProjectDialog(projectId) {
  if (!refs.progressProjectDialog || !refs.progressProjectNameInput) {
    return;
  }

  const ownerUserId = normalizeLoginId(progressEditProjectOwnerUserId || state.currentUserId);
  if (!ownerUserId || !canManageProgressOwner(ownerUserId)) {
    setNotice("このユーザーの工程管理は編集できません。");
    return;
  }

  progressEditProjectId = projectId || null;
  progressEditProjectOwnerUserId = ownerUserId;

  if (projectId) {
    const project = getProjectsByUserId(ownerUserId).find((p) => p.id === projectId);
    if (!project) {
      return;
    }
    if (refs.progressProjectDialogTitle) {
      refs.progressProjectDialogTitle.textContent = "現場を編集";
    }
    refs.progressProjectNameInput.value = project.name || "";
    if (refs.progressProjectLocationInput) {
      refs.progressProjectLocationInput.value = project.location || "";
    }
    if (refs.progressProjectStartDateInput) {
      refs.progressProjectStartDateInput.value = project.startDate || "";
    }
    if (refs.progressProjectEndDateInput) {
      refs.progressProjectEndDateInput.value = project.endDate || "";
    }
  } else {
    if (refs.progressProjectDialogTitle) {
      refs.progressProjectDialogTitle.textContent = "現場を追加";
    }
    refs.progressProjectNameInput.value = "";
    if (refs.progressProjectLocationInput) {
      refs.progressProjectLocationInput.value = "";
    }
    if (refs.progressProjectStartDateInput) {
      refs.progressProjectStartDateInput.value = "";
    }
    if (refs.progressProjectEndDateInput) {
      refs.progressProjectEndDateInput.value = "";
    }
  }

  openDialog(refs.progressProjectDialog);
}

async function saveProgressProject() {
  if (!currentFirebaseUser) {
    setNotice("ログイン後に操作できます。");
    return;
  }

  const ownerUserId = normalizeLoginId(progressEditProjectOwnerUserId || state.currentUserId);
  if (!ownerUserId || !canManageProgressOwner(ownerUserId)) {
    setNotice("このユーザーの工程管理は編集できません。");
    return;
  }

  const name = String(refs.progressProjectNameInput?.value || "").trim();
  if (!name) {
    return;
  }
  const location = String(refs.progressProjectLocationInput?.value || "").trim();
  const startDate = String(refs.progressProjectStartDateInput?.value || "").trim();
  const endDate = String(refs.progressProjectEndDateInput?.value || "").trim();

  const entry = ensureProjectsEntryByUserId(ownerUserId);
  if (!entry) {
    setNotice("ログイン後に操作できます。");
    return;
  }
  if (!Array.isArray(entry.projects)) entry.projects = [];

  if (progressEditProjectId) {
    const project = entry.projects.find((p) => p.id === progressEditProjectId);
    if (project) {
      project.name = name;
      project.location = location;
      project.startDate = startDate || null;
      project.endDate = endDate || null;
    }
  } else {
    entry.projects.push({
      id: generateProgressId(),
      name,
      location,
      startDate: startDate || null,
      endDate: endDate || null,
      items: [],
      createdAt: new Date().toISOString(),
      createdByName: state.currentUser || ownerUserId,
      createdById: state.currentUserId || ownerUserId,
    });
  }

  closeDialog(refs.progressProjectDialog);
  renderProgressSection();
  renderMonthlyCalendar();
  await saveStateImmediately();
  setNotice(progressEditProjectId ? "現場を更新しました。" : "現場を追加しました。");
}

function openProgressItemDialog(projectId, itemId, ownerUserId = state.currentUserId) {
  if (!refs.progressItemDialog || !refs.progressItemNameInput) {
    return;
  }

  const normalizedOwnerUserId = normalizeLoginId(ownerUserId);
  if (!normalizedOwnerUserId || !canManageProgressOwner(normalizedOwnerUserId)) {
    setNotice("このユーザーの工程管理は編集できません。");
    return;
  }

  progressEditItemProjectId = projectId;
  progressEditItemId = itemId || null;
  progressEditItemOwnerUserId = normalizedOwnerUserId;

  if (itemId) {
    const project = getProjectsByUserId(normalizedOwnerUserId).find((p) => p.id === projectId);
    const item = (project?.items || []).find((i) => i.id === itemId);
    if (!item) {
      return;
    }
    if (refs.progressItemDialogTitle) {
      refs.progressItemDialogTitle.textContent = "工種を編集";
    }
    refs.progressItemNameInput.value = item.name || "";
    if (refs.progressItemNoteInput) {
      refs.progressItemNoteInput.value = item.note || "";
    }
  } else {
    if (refs.progressItemDialogTitle) {
      refs.progressItemDialogTitle.textContent = "工種を追加";
    }
    refs.progressItemNameInput.value = "";
    if (refs.progressItemNoteInput) {
      refs.progressItemNoteInput.value = "";
    }
  }

  openDialog(refs.progressItemDialog);
}

async function saveProgressItem() {
  if (!currentFirebaseUser) {
    setNotice("ログイン後に操作できます。");
    return;
  }

  const ownerUserId = normalizeLoginId(progressEditItemOwnerUserId || state.currentUserId);
  if (!ownerUserId || !canManageProgressOwner(ownerUserId)) {
    setNotice("このユーザーの工程管理は編集できません。");
    return;
  }

  const name = String(refs.progressItemNameInput?.value || "").trim();
  if (!name) {
    return;
  }
  const note = String(refs.progressItemNoteInput?.value || "").trim();

  const entry = ensureProjectsEntryByUserId(ownerUserId);
  if (!entry) {
    setNotice("ログイン後に操作できます。");
    return;
  }
  const project = (entry.projects || []).find((p) => p.id === progressEditItemProjectId);
  if (!project) {
    return;
  }
  if (!Array.isArray(project.items)) {
    project.items = [];
  }

  if (progressEditItemId) {
    const item = project.items.find((i) => i.id === progressEditItemId);
    if (item) {
      item.name = name;
      item.note = note;
    }
  } else {
    project.items.push({
      id: generateProgressId(),
      name,
      progress: 0,
      note,
      updatedAt: "",
      updatedByName: "",
      updatedById: "",
    });
  }

  closeDialog(refs.progressItemDialog);
  renderProgressSection();
  await saveStateImmediately();
  setNotice(progressEditItemId ? "工種を更新しました。" : "工種を追加しました。");
}

function updateProgressItemProgress(projectId, itemId, progress, ownerUserId) {
  if (!currentFirebaseUser) {
    setNotice("ログイン後に進捗を更新できます。");
    return;
  }
  const normalizedOwnerUserId = normalizeLoginId(ownerUserId);
  if (!canManageProgressOwner(normalizedOwnerUserId)) {
    setNotice("他のユーザーのデータは編集できません。");
    return;
  }

  const entry = (state.progressProjectsByUser || {})[normalizedOwnerUserId];
  const project = (entry?.projects || []).find((p) => p.id === projectId);
  if (!project) {
    return;
  }
  const item = (project.items || []).find((i) => i.id === itemId);
  if (!item) {
    return;
  }

  item.progress = clamp(Number(progress), 0, 100);
  item.updatedAt = new Date().toISOString();
  item.updatedByName = state.currentUser || normalizedOwnerUserId || "";
  item.updatedById = state.currentUserId || normalizedOwnerUserId || "";

  const viewportY = window.scrollY;
  renderProgressSection();
  window.scrollTo({ top: viewportY, left: window.scrollX, behavior: "auto" });
  restoreProgressInputFocus(projectId, itemId);

  if (progressSaveTimer) {
    clearTimeout(progressSaveTimer);
  }
  progressSaveTimer = setTimeout(async () => {
    await saveStateImmediately();
  }, 800);
}

async function handleProgressListClick(event) {
  const rawTarget = event.target;
  const target = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;
  if (!(target instanceof Element)) {
    return;
  }

  // ボタンクリックを最優先で処理
  const button = target.closest("button[data-progress-action]");
  if (button) {
    // イベント伝播を停止
    event.preventDefault();
    event.stopPropagation();
    
    const action = button.dataset.progressAction;
    const projectId = String(button.dataset.projectId || "");
    const itemId = String(button.dataset.itemId || "");
    const userId = String(button.dataset.userId || "");

    if (action === "add-item") {
      openProgressItemDialog(projectId, null, userId);
    } else if (action === "toggle-delivered") {
      if (!canManageProgressOwner(userId)) {
        setNotice("他のユーザーのデータは編集できません。");
        return;
      }
      const entryD = ensureProjectsEntryByUserId(userId);
      const project = (entryD?.projects || []).find((p) => p.id === projectId);
      if (!project) {
        return;
      }

      const isDelivered = project?.deliveryStatus === "delivered";
      if (!isDelivered) {
        if (!confirm("この現場を納品完了にしますか？\n納品済みは工程カレンダーから非表示になります。")) {
          return;
        }
        project.deliveryStatus = "delivered";
        project.deliveredAt = new Date().toISOString();
        project.deliveredByName = state.currentUser || state.currentUserId || "";
        project.deliveredById = state.currentUserId || "";
        setNotice("納品完了にしました。誤操作時は「納品完了を取り消す」で戻せます。");
      } else {
        if (!confirm("納品完了を取り消しますか？")) {
          return;
        }
        project.deliveryStatus = "";
        project.deliveredAt = "";
        project.deliveredByName = "";
        project.deliveredById = "";
        setNotice("納品完了を取り消しました。");
      }

      renderProgressSection();
      renderMonthlyCalendar();
      await saveStateImmediately();
    } else if (action === "edit-project") {
      progressEditProjectOwnerUserId = normalizeLoginId(userId || state.currentUserId);
      openProgressProjectDialog(projectId);
    } else if (action === "delete-project") {
      if (!canManageProgressOwner(userId)) {
        setNotice("他のユーザーのデータは編集できません。");
        return;
      }
      if (!confirm("この業務を削除しますか？工種データもすべて削除されます。")) {
        return;
      }
      const entryD = ensureProjectsEntryByUserId(userId);
      if (entryD) {
        entryD.projects = (entryD.projects || []).filter((p) => p.id !== projectId);
      }
      renderProgressSection();
      renderMonthlyCalendar();
      await saveStateImmediately();
      setNotice("業務を削除しました。");
    } else if (action === "edit-item") {
      openProgressItemDialog(projectId, itemId, userId);
    } else if (action === "delete-item") {
      if (!canManageProgressOwner(userId)) {
        setNotice("他のユーザーのデータは編集できません。");
        return;
      }
      if (!confirm("この工種を削除しますか？")) {
        return;
      }
      const entryI = ensureProjectsEntryByUserId(userId);
      const project = (entryI?.projects || []).find((p) => p.id === projectId);
      if (project) {
        project.items = (project.items || []).filter((i) => i.id !== itemId);
      }
      renderProgressSection();
      await saveStateImmediately();
      setNotice("工種を削除しました。");
    } else if (action === "increment") {
      const inputField = button.closest(".progress-input-controls")?.querySelector(".progress-pct-input");
      if (inputField && inputField instanceof HTMLInputElement) {
        const currentValue = Number(inputField.value);
        if (currentValue < 100) {
          const newValue = Math.min(currentValue + 10, 100);
          inputField.value = String(newValue);
          updateProgressItemProgress(projectId, itemId, newValue, userId);
        }
      }
    } else if (action === "decrement") {
      const inputField = button.closest(".progress-input-controls")?.querySelector(".progress-pct-input");
      if (inputField && inputField instanceof HTMLInputElement) {
        const currentValue = Number(inputField.value);
        if (currentValue > 0) {
          const newValue = Math.max(currentValue - 10, 0);
          inputField.value = String(newValue);
          updateProgressItemProgress(projectId, itemId, newValue, userId);
        }
      }
    }
    return;
  }

  // toggle-items アクション（ヘッダー全体をクリック）
  const headerWithToggle = target.closest("[data-progress-action='toggle-items']");
  if (headerWithToggle) {
    const projectId = String(headerWithToggle.dataset.projectId || "");
    const card = headerWithToggle.closest(".progress-project-card");
    if (card) {
      const isExpanded = card.dataset.expanded === "true";
      const container = card.querySelector(".progress-items-container");
      const emptyMsg = card.querySelector(".progress-items-container ~ .subtitle-mini");
      const toggle = card.querySelector(".progress-project-toggle");

      if (isExpanded) {
        card.dataset.expanded = "false";
        if (container) container.style.display = "none";
        if (emptyMsg && emptyMsg.parentElement === card) emptyMsg.style.display = "none";
        if (toggle) toggle.textContent = "▶";
      } else {
        card.dataset.expanded = "true";
        if (container) container.style.display = "block";
        if (emptyMsg && emptyMsg.parentElement === card) emptyMsg.style.display = "block";
        if (toggle) toggle.textContent = "▼";
      }

      refreshProgressLayoutAfterToggle();
    }
  }
}

function handleProgressListChange(event) {
  const rawTarget = event.target;
  const target = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  if (target.dataset.progressAction !== "update-progress") {
    return;
  }

  const projectId = String(target.dataset.projectId || "");
  const itemId = String(target.dataset.itemId || "");
  const userId = String(target.dataset.userId || "");
  const progress = Number(target.value);

  updateProgressItemProgress(projectId, itemId, progress, userId);
}

function refreshProgressLayoutAfterToggle() {
  if (typeof window === "undefined") {
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const containers = refs.progressProjectList?.querySelectorAll(".progress-items-container") || [];
      containers.forEach((container) => {
        if (!(container instanceof HTMLElement)) {
          return;
        }
        container.style.maxWidth = "100%";
      });

      window.dispatchEvent(new Event("resize"));
      syncTableScrollbar();
    });
  });
}

// ─────────────────────────────────────────────────────────

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
      const mergedCloudData = mergeCloudDataWithPersonalDraft(cloudData);
      const remoteUpdatedAt = normalizeTimestamp(cloudData.updatedAt);
      if (!remoteUpdatedAt) {
        return;
      }

      if (!lastKnownRemoteUpdatedAt) {
        lastKnownRemoteUpdatedAt = remoteUpdatedAt;
        applyLoadedData(mergedCloudData, false);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
        await render();

        // 初回同期でも自分宛の承認待ち依頼があれば通知する
        if (getPendingIncomingRequests(cloudData.confirmationRequests).length > 0) {
          notifyRemoteUpdate(cloudData);
        }
        return;
      }

      if (remoteUpdatedAt === lastKnownRemoteUpdatedAt) {
        return;
      }

      lastKnownRemoteUpdatedAt = remoteUpdatedAt;
      applyLoadedData(mergedCloudData, false);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
      await render();

      if (remoteUpdatedAt !== lastLocalSaveUpdatedAt && !isOwnCloudUpdate(cloudData)) {
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

  if (refs.printDateRange) {
    refs.printDateRange.textContent = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 〜 ${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`;
  }
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
  const personalRowName = getPersonalRowName();
  const visibleStaff = isPersonalPage
    ? personalRowName
      ? [personalRowName]
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
      const isEditable = canEditRow(name);
      const statusClass = getStatusClass(entry);

      btn.type = "button";
      btn.className = `cell-btn ${entry ? entry.source : ""} ${statusClass} ${isEditable ? "" : "readonly"}`.trim();
      btn.innerHTML = renderCellHtml(entry);

      if (isEditable) {
        btn.addEventListener("click", () => {
          // 最新の手動入力データを必ず渡す
          const manualEntry = state.manualEntries[entryKey(name, dateStr)];
          openEditDialog(name, dateStr, manualEntry);
        });
      } else {
        btn.disabled = true;
        btn.title = state.isAdmin
          ? "管理者または本人のみ編集できます"
          : "個人入力ページで本人ログイン時のみ編集できます";
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
  syncTableScrollbar();
}

function renderMonthlyCalendar() {
  if (!refs.monthlyScheduleTable || !refs.monthLabel) {
    return;
  }
  if (!isPersonalPage && !isOverallPage) {
    return;
  }

  const monthStart = getMonthStart(state.currentMonthStart || new Date());
  state.currentMonthStart = monthStart;
  refs.monthLabel.textContent = `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`;

  if (isPersonalPage) {
    const targetName = getLoggedInScheduleTargetName();
    if (!targetName) {
      refs.monthlyScheduleTable.innerHTML = "<tbody><tr><td class=\"monthly-empty\">ログイン中ユーザーの工程表示対象が見つかりません。</td></tr></tbody>";
      return;
    }

    renderSingleMonthlyTable({
      tableEl: refs.monthlyScheduleTable,
      monthStart,
      targetName,
    });
    return;
  }

  renderOverallMonthlyTable({
    tableEl: refs.monthlyScheduleTable,
    monthStart,
  });

  syncMonthlyScrollbar();
}

function createMonthlyTableHeader() {
  const weekDays = ["月", "火", "水", "木", "金", "土", "日"];
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  for (const wd of weekDays) {
    const th = document.createElement("th");
    th.textContent = wd;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);
  return thead;
}

function renderOverallMonthlyTable({ tableEl, monthStart }) {
  renderOverallMonthlyGanttTable({
    tableEl,
    monthStart,
  });
}

function renderSingleMonthlyTable({ tableEl, monthStart, targetName }) {
  renderOverallMonthlyGanttTable({
    tableEl,
    monthStart,
    owners: getPersonalProjectOwner(targetName),
  });
}

function getOverallProjectOwners() {
  const owners = [];
  const seenIds = new Set();

  for (const [loginId, entry] of Object.entries(state.progressProjectsByUser || {})) {
    const normalizedLoginId = normalizeLoginId(loginId);
    const projects = Array.isArray(entry?.projects) ? entry.projects : [];
    if (!normalizedLoginId || seenIds.has(normalizedLoginId) || projects.length === 0) {
      continue;
    }
    seenIds.add(normalizedLoginId);
    const account = findAccountByLoginId(normalizedLoginId);
    owners.push({
      loginId: normalizedLoginId,
      displayName: account?.name
        || entry?.userName
        || resolveRowNameByLoginId(normalizedLoginId, normalizedLoginId)
        || normalizedLoginId,
    });
  }

  return owners;
}

function getPersonalProjectOwner(targetName) {
  const loginId = findLoginIdByUserName(targetName) || targetName;
  return [{
    loginId: normalizeLoginId(loginId),
    displayName: targetName,
  }];
}

function getDatesInMonth(monthStart) {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, index) => new Date(year, month, index + 1));
}

function getGanttOffLabel(dateStr, entry) {
  const source = String(entry?.source || "");
  if (source === "holiday") {
    return String(getHolidayName(dateStr) || "祝日");
  }
  return "休";
}

function renderOverallMonthlyGanttTable({ tableEl, monthStart, owners: ownersOverride = null }) {
  const owners = Array.isArray(ownersOverride) ? ownersOverride : getOverallProjectOwners();
  const monthDates = getDatesInMonth(monthStart);

  const table = document.createElement("table");
  table.className = "monthly-table monthly-gantt-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const userHead = document.createElement("th");
  userHead.className = "monthly-gantt-user-head";
  userHead.textContent = "";
  headerRow.appendChild(userHead);

  for (const date of monthDates) {
    const th = document.createElement("th");
    const dateStr = toISODate(date);
    const holidayName = String(getHolidayName(dateStr) || "").trim();

    th.className = "monthly-gantt-day-head";
    if (date.getDay() === 0 || date.getDay() === 6) {
      th.classList.add("is-weekend");
    }
    if (holidayName) {
      th.classList.add("is-holiday");
      th.title = holidayName;
    }

    th.textContent = String(date.getDate());
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");

  for (const owner of owners) {
    const tr = document.createElement("tr");

    const userCell = document.createElement("th");
    userCell.className = "monthly-gantt-user-cell";
    userCell.textContent = owner.displayName;
    tr.appendChild(userCell);

    for (const date of monthDates) {
      const dateStr = toISODate(date);
      const td = document.createElement("td");
      td.className = "monthly-gantt-cell";
      const entry = resolveEntry(owner.displayName, dateStr);
      const isOffEntry = isEngineeringCalendarOffEntry(entry);

      if (date.getDay() === 0 || date.getDay() === 6) {
        td.classList.add("is-weekend");
      }
      if (getHolidayName(dateStr)) {
        td.classList.add("is-holiday");
      }

      const segmentWrap = document.createElement("div");
      segmentWrap.className = "monthly-gantt-segment-wrap";

      if (isOffEntry) {
        const offEl = document.createElement("div");
        offEl.className = "monthly-gantt-off-entry";
        const offSource = String(entry?.source || "");
        offEl.classList.add(offSource === "holiday" ? "is-holiday" : "is-off");
        offEl.textContent = getGanttOffLabel(dateStr, entry);
        offEl.title = buildEngineeringOffLabel(entry);
        segmentWrap.appendChild(offEl);
      }

      const activeProjects = getActiveProjectsForUserOnDate(owner.loginId, dateStr);
      for (const project of activeProjects) {
        if (isOffEntry) {
          continue;
        }
        if (shouldSkipProjectTimeline(dateStr, owner.displayName, owner.loginId)) {
          continue;
        }

        const segment = createProjectTimelineSegment(project, dateStr, {
          compact: true,
          showLabel: false,
          labelText: buildEngineeringProjectLabel(project),
        });
        segment.classList.add("monthly-gantt-segment-item");
        segmentWrap.appendChild(segment);
      }

      if (segmentWrap.childElementCount > 0) {
        td.appendChild(segmentWrap);
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  if (owners.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "monthly-empty";
    td.colSpan = monthDates.length + 1;
    td.textContent = "工程データがありません。";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tbody);

  tableEl.innerHTML = "";
  tableEl.appendChild(table);
}

function renderProjectMonthlyTable({ tableEl, monthStart, mode, targetName }) {
  const thead = createMonthlyTableHeader();
  const owners = mode === "personal"
    ? getPersonalProjectOwner(targetName)
    : getOverallProjectOwners();

  const tbody = document.createElement("tbody");
  const monthStartWeekdayFromMonday = (monthStart.getDay() + 6) % 7;
  const firstVisible = addDays(monthStart, -monthStartWeekdayFromMonday);
  for (let row = 0; row < 6; row += 1) {
    const tr = document.createElement("tr");
    for (let col = 0; col < 7; col += 1) {
      const date = addDays(firstVisible, row * 7 + col);
      const dateStr = toISODate(date);
      const td = document.createElement("td");
      const inCurrentMonth = date.getMonth() === monthStart.getMonth();
      if (!inCurrentMonth) {
        td.classList.add("monthly-muted");
      }
      if (date.getDay() === 0) {
        td.classList.add("monthly-sunday");
      }

      const dayNo = document.createElement("div");
      dayNo.className = "monthly-day-no";
      dayNo.textContent = String(date.getDate());

      td.appendChild(dayNo);

      td.classList.add("monthly-overall-cell");
      const listEl = document.createElement("div");
      listEl.className = "monthly-entry-list";

      let hasAnyEntry = false;
      if (mode === "overall") {
        const overallOffLabel = getOverallCalendarDayOffLabel(date, dateStr);
        if (overallOffLabel) {
          hasAnyEntry = true;
          const offLineEl = document.createElement("div");
          offLineEl.className = "monthly-entry-line";

          const offTextEl = document.createElement("span");
          offTextEl.className = "monthly-entry-main monthly-entry-off";
          offTextEl.textContent = overallOffLabel;

          offLineEl.appendChild(offTextEl);
          listEl.appendChild(offLineEl);
        }
      }

      for (const owner of owners) {
        const entry = resolveEntry(owner.displayName, dateStr);
        if (isEngineeringCalendarOffEntry(entry) && shouldRenderEngineeringOffEntry(entry, mode)) {
          hasAnyEntry = true;
          const offLineEl = document.createElement("div");
          offLineEl.className = "monthly-entry-line";

          const offTextEl = document.createElement("span");
          offTextEl.className = "monthly-entry-main monthly-entry-off";
          const offLabel = buildEngineeringOffLabel(entry);
          offTextEl.textContent = mode === "overall"
            ? `${owner.displayName}: ${offLabel}`
            : offLabel;

          offLineEl.appendChild(offTextEl);
          listEl.appendChild(offLineEl);
        }

        const activeProjects = getActiveProjectsForUserOnDate(owner.loginId, dateStr);
        for (const project of activeProjects) {
          if (shouldSkipProjectTimeline(dateStr, owner.displayName, owner.loginId)) {
            continue;
          }

          hasAnyEntry = true;
          const lineEl = document.createElement("div");
          lineEl.className = "monthly-entry-line";

          const labelText = buildEngineeringProjectLabel(project, {
            includeOwner: mode === "overall",
            ownerName: owner.displayName,
          });

          lineEl.appendChild(createProjectTimelineSegment(project, dateStr, {
            compact: mode !== "personal",
            showLabel: shouldShowProjectTimelineLabel(dateStr, project, mode),
            labelText,
          }));

          listEl.appendChild(lineEl);
        }
      }

      if (!hasAnyEntry) {
        const emptyEl = document.createElement("div");
        emptyEl.className = "monthly-empty";
        emptyEl.textContent = "-";
        listEl.appendChild(emptyEl);
      }

      td.appendChild(listEl);

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  tableEl.innerHTML = "";
  tableEl.appendChild(thead);
  tableEl.appendChild(tbody);
}

function getOverallCalendarDayOffLabel(date, dateStr) {
  const holidayName = String(getHolidayName(dateStr) || "").trim();
  if (holidayName) {
    return `（祝日）${holidayName}`;
  }

  if (date.getDay() === 0 || date.getDay() === 6) {
    return "休み";
  }

  return "";
}

function getActiveProjectsForUserOnDate(userId, dateStr) {
  const normalizedUserId = normalizeLoginId(userId);
  if (!normalizedUserId || !dateStr) {
    return [];
  }

  const userEntry = (state.progressProjectsByUser || {})[normalizedUserId];
  const projects = Array.isArray(userEntry?.projects) ? userEntry.projects : [];
  return projects.filter((project) => {
    if (project?.deliveryStatus === "delivered") {
      return false;
    }
    return isDateWithinProjectRange(dateStr, project?.startDate, project?.endDate);
  });
}

function shouldSkipProjectTimeline(dateStr, rowName, userId) {
  const resolvedName = rowName || resolveRowNameByLoginId(userId, userId);
  const entry = resolveEntry(resolvedName, dateStr);
  const source = String(entry?.source || "");
  return source === "holiday" || source === "sunday" || source === "company";
}

function shouldShowProjectTimelineLabel(dateStr, project, mode = "personal") {
  const start = String(project?.startDate || "").trim();
  if (!dateStr) {
    return false;
  }

  if (start && start === dateStr) {
    return true;
  }

  const date = fromISODate(dateStr);
  if (mode === "overall" && date.getDay() === 1) {
    return true;
  }
  return date.getDate() === 1;
}

function buildEngineeringProjectLabel(project, options = {}) {
  const includeOwner = options.includeOwner === true;
  const ownerName = String(options.ownerName || "").trim();
  const siteName = String(project?.location || "").trim() || "未設定";
  const body = `現場: ${siteName}`;
  return includeOwner && ownerName ? `${ownerName}: ${body}` : body;
}

function isEngineeringCalendarOffEntry(entry) {
  if (!entry) {
    return false;
  }

  const source = String(entry.source || "");
  if (source === "holiday" || source === "sunday" || source === "company") {
    return true;
  }

  const status = String(entry.status || "").trim();
  return status === "休み" || status === "有給";
}

function shouldRenderEngineeringOffEntry(entry, mode) {
  if (mode !== "overall") {
    return true;
  }

  const source = String(entry?.source || "");
  return source !== "holiday" && source !== "sunday" && source !== "company";
}

function buildEngineeringOffLabel(entry) {
  const status = String(formatEntryStatusText(entry) || "").trim() || "休み";
  const work = String(formatEntryWorkText(entry) || "").trim();
  return work ? `${status} / ${work}` : status;
}

function isDateWithinProjectRange(dateStr, startDate, endDate) {
  const date = String(dateStr || "");
  const start = String(startDate || "").trim();
  const end = String(endDate || "").trim();

  if (!start && !end) {
    return false;
  }
  if (start && end && start > end) {
    return false;
  }
  if (start && date < start) {
    return false;
  }
  if (end && date > end) {
    return false;
  }
  return true;
}

function getProjectColorById(projectId) {
  const text = String(projectId || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    background: `hsl(${hue} 85% 92%)`,
    border: `hsl(${hue} 62% 52%)`,
    text: `hsl(${hue} 62% 28%)`,
  };
}

function createProjectTimelineSegment(project, dateStr, options = {}) {
  const isCompact = options.compact === true;
  const showLabel = options.showLabel === true;
  const customLabelText = String(options.labelText || "").trim();
  const segmentEl = document.createElement("span");
  segmentEl.className = isCompact
    ? "monthly-project-segment monthly-project-segment-compact"
    : "monthly-project-segment";

  const start = String(project?.startDate || "").trim();
  const end = String(project?.endDate || "").trim();
  const isStart = Boolean(start && start === dateStr);
  const isEnd = Boolean(end && end === dateStr);

  if (isStart) {
    segmentEl.classList.add("is-start");
  }
  if (isEnd) {
    segmentEl.classList.add("is-end");
  }

  const color = getProjectColorById(project?.id || project?.name || "project");
  const displayLabel = customLabelText || buildEngineeringProjectLabel(project);
  segmentEl.style.color = color.text;
  segmentEl.title = `${displayLabel}${start ? ` / 開始:${start}` : ""}${end ? ` / 終了:${end}` : ""}`;
  segmentEl.setAttribute("aria-label", segmentEl.title);

  const barEl = document.createElement("span");
  barEl.className = "monthly-project-segment-bar";
  barEl.style.backgroundColor = color.background;
  barEl.style.boxShadow = `0 0 0 1px ${color.border} inset`;
  segmentEl.appendChild(barEl);

  if (showLabel) {
    const labelEl = document.createElement("span");
    labelEl.className = "monthly-project-segment-label";
    labelEl.textContent = displayLabel;
    segmentEl.insertBefore(labelEl, barEl);
  }

  return segmentEl;
}

function getLoggedInScheduleTargetName() {
  const loginId = normalizeLoginId(state.currentUserId);
  if (loginId) {
    const account = findAccountByLoginId(loginId);
    if (account?.name) {
      return account.name;
    }
  }
  if (isPersonalPage) {
    return getPersonalRowName();
  }
  return "";
}

function bindTableScrollbarSync() {
  if (!refs.scheduleTable || !refs.scheduleScrollbar) {
    return;
  }

  const wrap = refs.scheduleTable.closest(".table-wrap");
  if (!wrap) {
    return;
  }

  if (wrap.dataset.scrollSyncBound !== "1") {
    wrap.dataset.scrollSyncBound = "1";
    wrap.addEventListener("scroll", () => {
      if (!refs.scheduleScrollbar || tableScrollbarSyncing) {
        return;
      }
      tableScrollbarSyncing = true;
      refs.scheduleScrollbar.scrollLeft = wrap.scrollLeft;
      tableScrollbarSyncing = false;
    });
  }

  if (refs.scheduleScrollbar.dataset.scrollSyncBound !== "1") {
    refs.scheduleScrollbar.dataset.scrollSyncBound = "1";
    refs.scheduleScrollbar.addEventListener("scroll", () => {
      if (tableScrollbarSyncing) {
        return;
      }
      tableScrollbarSyncing = true;
      wrap.scrollLeft = refs.scheduleScrollbar.scrollLeft;
      tableScrollbarSyncing = false;
    });
  }

  if (!tableScrollbarResizeBound) {
    tableScrollbarResizeBound = true;
    window.addEventListener("resize", () => {
      if (window.innerWidth <= 768) {
        return;
      }
      syncTableScrollbar();
      syncMonthlyScrollbar();
    });
  }
}

function syncTableScrollbar() {
  if (!refs.scheduleTable || !refs.scheduleScrollbar || !refs.scheduleScrollbarInner) {
    return;
  }

  if (window.innerWidth <= 768) {
    refs.scheduleScrollbar.classList.add("hidden");
    refs.scheduleScrollbar.scrollLeft = 0;
    refs.scheduleScrollbarInner.style.width = "1px";
    return;
  }

  const wrap = refs.scheduleTable.closest(".table-wrap");
  if (!wrap) {
    return;
  }

  const contentWidth = Math.ceil(refs.scheduleTable.scrollWidth);
  const viewportWidth = Math.ceil(wrap.clientWidth);

  if (contentWidth <= viewportWidth + 1) {
    refs.scheduleScrollbar.classList.add("hidden");
    refs.scheduleScrollbar.scrollLeft = 0;
    refs.scheduleScrollbarInner.style.width = "1px";
    return;
  }

  refs.scheduleScrollbar.classList.remove("hidden");
  refs.scheduleScrollbarInner.style.width = `${contentWidth}px`;
  refs.scheduleScrollbar.scrollLeft = wrap.scrollLeft;
}

function bindMonthlyScrollbarSync() {
  if (!refs.monthlyScheduleTable || !refs.monthlyScrollbar) {
    return;
  }

  const wrap = refs.monthlyScheduleTable.closest(".table-wrap");
  if (!wrap) {
    return;
  }

  if (wrap.dataset.monthlyScrollSyncBound !== "1") {
    wrap.dataset.monthlyScrollSyncBound = "1";
    wrap.addEventListener("scroll", () => {
      if (!refs.monthlyScrollbar || monthlyScrollbarSyncing) {
        return;
      }
      monthlyScrollbarSyncing = true;
      refs.monthlyScrollbar.scrollLeft = wrap.scrollLeft;
      monthlyScrollbarSyncing = false;
    });
  }

  if (refs.monthlyScrollbar.dataset.monthlyScrollSyncBound !== "1") {
    refs.monthlyScrollbar.dataset.monthlyScrollSyncBound = "1";
    refs.monthlyScrollbar.addEventListener("scroll", () => {
      if (monthlyScrollbarSyncing) {
        return;
      }
      monthlyScrollbarSyncing = true;
      wrap.scrollLeft = refs.monthlyScrollbar.scrollLeft;
      monthlyScrollbarSyncing = false;
    });
  }

}

function syncMonthlyScrollbar() {
  if (!refs.monthlyScheduleTable || !refs.monthlyScrollbar || !refs.monthlyScrollbarInner) {
    return;
  }

  if (window.innerWidth <= 768) {
    refs.monthlyScrollbar.classList.add("hidden");
    refs.monthlyScrollbar.scrollLeft = 0;
    refs.monthlyScrollbarInner.style.width = "1px";
    return;
  }

  const wrap = refs.monthlyScheduleTable.closest(".table-wrap");
  if (!wrap) {
    return;
  }

  const contentWidth = Math.ceil(refs.monthlyScheduleTable.scrollWidth);
  const viewportWidth = Math.ceil(wrap.clientWidth);

  if (contentWidth <= viewportWidth + 1) {
    refs.monthlyScrollbar.classList.add("hidden");
    refs.monthlyScrollbar.scrollLeft = 0;
    refs.monthlyScrollbarInner.style.width = "1px";
    return;
  }

  refs.monthlyScrollbar.classList.remove("hidden");
  refs.monthlyScrollbarInner.style.width = `${contentWidth}px`;
  refs.monthlyScrollbar.scrollLeft = wrap.scrollLeft;
}

function renderCellHtml(entry) {
  if (!entry) {
    return `<div class="cell-status">-</div><div class="cell-work">未入力</div>`;
  }

  const statusText = formatEntryStatusText(entry);
  const statusHtml = formatCellStatusHtml(statusText);
  const work = formatEntryWorkText(entry);
  const place = formatEntryPlaceText(entry);

  return `
    <div class="cell-status">${statusHtml}</div>
    <div class="cell-work">${escapeHtml(work)}</div>
    <div class="cell-place">${escapeHtml(place)}</div>
  `;
}

function formatCellStatusHtml(statusText) {
  const text = String(statusText || "");
  if (!text.includes("/")) {
    return escapeHtml(text);
  }

  // 半日休みなどで " / " を含む状態は、スラッシュ区切りで改行して横伸びを防ぐ
  return escapeHtml(text).replace(/\s*\/\s*/g, "<br>/ ");
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
    li.draggable = true;
    li.dataset.index = String(index);

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "ドラッグして並び替え";
    handle.setAttribute("aria-hidden", "true");

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

    const editNameBtn = document.createElement("button");
    editNameBtn.type = "button";
    editNameBtn.className = "btn btn-secondary order-btn";
    editNameBtn.textContent = "名前変更";
    editNameBtn.dataset.action = "edit-name";
    editNameBtn.dataset.index = String(index);

    buttons.appendChild(editNameBtn);
    buttons.appendChild(upBtn);
    buttons.appendChild(downBtn);
    buttons.appendChild(deleteBtn);
    li.appendChild(handle);
    li.appendChild(meta);
    li.appendChild(buttons);
    refs.userOrderList.appendChild(li);
  });

  bindDragAndDrop(refs.userOrderList);
}

function renderPasswordChangeUserOptions() {
  if (!refs.changePasswordUserSelect) {
    return;
  }

  if (!state.isAdmin) {
    refs.changePasswordUserSelect.innerHTML = '<option value="">選択してください</option>';
    return;
  }

  const currentValue = normalizeLoginId(refs.changePasswordUserSelect.value);
  const options = state.staffAccounts
    .filter((account) => {
      const accountId = normalizeLoginId(account.id);
      return Boolean(accountId) && !isAdminLoginId(accountId);
    })
    .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}（${escapeHtml(account.id)}）</option>`)
    .join("");

  refs.changePasswordUserSelect.innerHTML = `<option value="">選択してください</option>${options}`;

  if (currentValue) {
    const exists = Array.from(refs.changePasswordUserSelect.options)
      .some((option) => normalizeLoginId(option.value) === currentValue);
    if (exists) {
      refs.changePasswordUserSelect.value = currentValue;
    }
  }
}

function syncRequestFormUi() {
  const enabled = Boolean(refs.requestConfirmEnabled?.checked);
  if (refs.requestTargetInput) {
    refs.requestTargetInput.disabled = !enabled;
  }
  if (refs.requestMessageInput) {
    refs.requestMessageInput.disabled = !enabled;
  }
}

function getSelectedRequestTargetIds() {
  if (!refs.requestTargetInput) {
    return [];
  }

  const selectedValues = Array.from(refs.requestTargetInput.selectedOptions || [])
    .map((option) => normalizeLoginId(option.value))
    .filter(Boolean);

  if (selectedValues.length > 0) {
    return [...new Set(selectedValues)];
  }

  const fallbackValue = normalizeLoginId(refs.requestTargetInput.value || "");
  return fallbackValue ? [fallbackValue] : [];
}

function isMorningOffStatus(status) {
  return status === "午前休" || status === "午前有休";
}

function isAfternoonOffStatus(status) {
  return status === "午後休" || status === "午後有休";
}

function getHalfDayWorkingSlot(status) {
  if (isMorningOffStatus(status)) {
    return "午後";
  }
  if (isAfternoonOffStatus(status)) {
    return "午前";
  }
  return "";
}

function syncHalfDayInputUi(status) {
  const slot = getHalfDayWorkingSlot(status);
  const isHalfDayMode = Boolean(slot);
  const workLabel = slot ? `${slot}の業務内容` : "業務内容";
  const placeLabel = slot ? `${slot}の場所` : "場所";

  if (refs.workInputLabel) {
    refs.workInputLabel.textContent = workLabel;
    refs.workInputLabel.classList.toggle("halfday-highlight-label", isHalfDayMode);
  }
  if (refs.placeInputLabel) {
    refs.placeInputLabel.textContent = placeLabel;
    refs.placeInputLabel.classList.toggle("halfday-highlight-label", isHalfDayMode);
  }
  if (refs.workInput) {
    refs.workInput.placeholder = slot ? `例: ${slot}の作業内容` : "例: 官場線 作業準備";
    refs.workInput.classList.toggle("halfday-highlight-input", isHalfDayMode);
  }
  if (refs.placeInput) {
    refs.placeInput.placeholder = slot ? `例: ${slot}の訪問先` : "例: 鹿児島市";
    refs.placeInput.classList.toggle("halfday-highlight-input", isHalfDayMode);
  }
  if (refs.halfDayWorkHint) {
    refs.halfDayWorkHint.classList.toggle("halfday-highlight-hint", isHalfDayMode);
    if (slot) {
      refs.halfDayWorkHint.textContent = `${status}が選択されています。${slot}の業務を入力してください。`;
      refs.halfDayWorkHint.classList.remove("hidden");
    } else {
      refs.halfDayWorkHint.classList.add("hidden");
      refs.halfDayWorkHint.textContent = "";
    }
  }
}

function syncHalfDaySecondaryStatusUi(status) {
  if (!refs.secondaryStatusRow || !refs.secondaryStatusInput) {
    return;
  }

  const slot = getHalfDayWorkingSlot(status);
  if (!slot) {
    refs.secondaryStatusRow.classList.add("hidden");
    refs.secondaryStatusInput.value = "";
    return;
  }

  if (refs.secondaryStatusLabel) {
    refs.secondaryStatusLabel.textContent = `${slot}の状態`;
  }

  refs.secondaryStatusRow.classList.remove("hidden");
}

function formatEntryStatusText(entry) {
  const status = String(entry?.status || "").trim();
  if (!status) {
    return "";
  }

  const slot = getHalfDayWorkingSlot(status);
  const secondaryStatus = String(entry?.secondaryStatus || "").trim();
  if (slot && secondaryStatus) {
    return `${status} / ${slot}:${secondaryStatus}`;
  }

  return status;
}

function formatEntryWorkText(entry) {
  const work = String(entry?.work || "").trim();
  if (!work) {
    return "";
  }

  const slot = getHalfDayWorkingSlot(entry?.status || "");
  return slot ? `${slot}業務: ${work}` : work;
}

function formatEntryPlaceText(entry) {
  const place = String(entry?.place || "").trim();
  if (!place) {
    return "";
  }

  const slot = getHalfDayWorkingSlot(entry?.status || "");
  return slot ? `${slot}場所: ${place}` : place;
}

function populateRequestTargetOptions(ownerName) {
  if (!refs.requestTargetInput) {
    return;
  }

  const requesterId = normalizeLoginId(state.currentUserId);
  const candidates = state.staffAccounts
    .filter((account) => normalizeLoginId(account.id) !== requesterId && account.name !== ownerName)
    .map((account) => ({
      id: normalizeLoginId(account.id),
      name: account.name,
    }))
    .filter((account) => Boolean(account.id));

  refs.requestTargetInput.innerHTML = "";

  if (candidates.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "送信先がありません";
    option.disabled = true;
    refs.requestTargetInput.appendChild(option);
    return;
  }

  candidates.forEach((account) => {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    refs.requestTargetInput.appendChild(option);
  });
}

function renderRequestInbox() {
  if (!refs.requestInboxSection || !refs.requestInboxList) {
    return;
  }

  const incoming = getPendingIncomingRequests(state.confirmationRequests);
  const outgoing = getPendingOutgoingRequests(state.confirmationRequests);

  if (incoming.length === 0 && outgoing.length === 0) {
    refs.requestInboxSection.classList.add("hidden");
    refs.requestInboxList.innerHTML = "";
    return;
  }

  refs.requestInboxSection.classList.remove("hidden");
  const lines = [];

  for (const request of incoming) {
    const needsHalfDayDecision = hasHalfDayOnApproverSide(request);

    lines.push(`
      <li class="request-item">
        <div class="request-item-title">受信: ${escapeHtml(request.requesterName)} さんから確認依頼</div>
        <div class="request-item-meta">対象: ${escapeHtml(request.ownerName)} / ${escapeHtml(request.startDate)} / ${request.repeatDays}日分</div>
        <div class="request-item-meta">送信日時: ${escapeHtml(formatDateTimeLabel(request.createdAt))}</div>
        <div class="request-item-meta">内容: ${escapeHtml(formatEntryStatusText(request.entryData))}${request.entryData?.work ? ` / ${escapeHtml(request.entryData.work)}` : ""}${request.entryData?.place ? ` / ${escapeHtml(request.entryData.place)}` : ""}</div>
        ${request.message ? `<div class="request-item-meta">メモ: ${escapeHtml(request.message)}</div>` : ""}
        ${needsHalfDayDecision ? `
          <div class="request-item-meta">半日休が含まれています。休みの変更は可能ですか？</div>
          <div class="request-item-buttons">
            <button class="btn" type="button" data-request-action="halfday-allow" data-request-id="${escapeHtml(request.id)}">可能（全日上書き）</button>
            <button class="btn btn-secondary" type="button" data-request-action="halfday-deny" data-request-id="${escapeHtml(request.id)}">不可（非休み側のみ）</button>
          </div>
        ` : ""}
        ${needsHalfDayDecision ? "" : `
          <div class="request-item-buttons">
            <button class="btn" type="button" data-request-action="approve" data-request-id="${escapeHtml(request.id)}">承認</button>
            <button class="btn btn-secondary" type="button" data-request-action="reject" data-request-id="${escapeHtml(request.id)}">却下</button>
          </div>
        `}
      </li>
    `);
  }

  for (const request of outgoing) {
    lines.push(`
      <li class="request-item">
        <div class="request-item-title">送信: ${escapeHtml(request.targetName)} さんへ確認依頼中</div>
        <div class="request-item-meta">対象: ${escapeHtml(request.ownerName)} / ${escapeHtml(request.startDate)} / ${request.repeatDays}日分</div>
        <div class="request-item-meta">送信日時: ${escapeHtml(formatDateTimeLabel(request.createdAt))}</div>
        ${request.message ? `<div class="request-item-meta">メモ: ${escapeHtml(request.message)}</div>` : ""}
        <div class="request-item-buttons">
          <button class="btn btn-ghost" type="button" data-request-action="cancel" data-request-id="${escapeHtml(request.id)}">依頼を取消</button>
        </div>
      </li>
    `);
  }

  refs.requestInboxList.innerHTML = lines.join("");
}

function hasHalfDayOnApproverSide(request) {
  const currentId = normalizeLoginId(state.currentUserId);
  const approverPrimaryName = resolveRowNameByLoginId(currentId, request?.targetName || state.currentUser);
  const candidateNames = [
    approverPrimaryName,
    normalizeDisplayName(request?.targetName || ""),
    normalizeDisplayName(state.currentUser || ""),
    normalizeDisplayName(currentId || ""),
  ].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);

  if (candidateNames.length === 0 || !request?.startDate) {
    return false;
  }

  const repeatDays = clamp(Number(request.repeatDays || 1), 1, 12);
  const startDate = fromISODate(request.startDate);
  for (let i = 0; i < repeatDays; i += 1) {
    const targetDate = addDays(startDate, i);
    const dateStr = toISODate(targetDate);
    for (const approverRowName of candidateNames) {
      const entry = resolveEntry(approverRowName, dateStr);
      const status = normalizeDisplayName(entry?.status || "");
      if (getHalfDayWorkingSlot(status)) {
        return true;
      }
    }
  }

  return false;
}

function hasScheduleConflict(rowName, startDate, repeatDays = 1) {
  if (!rowName || !startDate) {
    return false;
  }

  const repeatDaysNum = clamp(Number(repeatDays || 1), 1, 12);
  const startDateObj = fromISODate(startDate);

  for (let i = 0; i < repeatDaysNum; i += 1) {
    const targetDate = addDays(startDateObj, i);
    const dateStr = toISODate(targetDate);
    const entry = resolveEntry(rowName, dateStr);

    if (entry && entry.status) {
      return true;
    }
  }

  return false;
}

function ensureDesktopRequestPanel() {
  if (desktopRequestPanelEl || typeof document === "undefined") {
    return;
  }

  const panel = document.createElement("section");
  panel.id = "desktopRequestPanel";
  panel.className = "desktop-request-panel hidden";
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `
    <div class="desktop-request-panel-title">確認依頼（承認待ち）</div>
    <ul id="desktopRequestList" class="desktop-request-list"></ul>
  `;

  document.body.appendChild(panel);
  desktopRequestPanelEl = panel;
  desktopRequestListEl = panel.querySelector("#desktopRequestList");

  if (desktopRequestListEl) {
    desktopRequestListEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-request-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.requestAction;
      const requestId = String(button.dataset.requestId || "");
      if (!action || !requestId) {
        return;
      }

      await handleConfirmationRequestAction(requestId, action);
    });
  }
}

function renderDesktopRequestPanel() {
  if (!desktopRequestPanelEl || !desktopRequestListEl) {
    return;
  }

  // PC画面のみ常駐表示（モバイルは既存セクションで対応）
  if (window.innerWidth < 900 || !currentFirebaseUser) {
    desktopRequestPanelEl.classList.add("hidden");
    desktopRequestListEl.innerHTML = "";
    return;
  }

  const incoming = getPendingIncomingRequests(state.confirmationRequests);
  if (incoming.length === 0) {
    desktopRequestPanelEl.classList.add("hidden");
    desktopRequestListEl.innerHTML = "";
    return;
  }

  desktopRequestPanelEl.classList.remove("hidden");
  desktopRequestListEl.innerHTML = incoming.map((request) => `
    ${(() => {
      const needsHalfDayDecision = hasHalfDayOnApproverSide(request);
      return `
    <li class="desktop-request-item">
      <div class="desktop-request-item-title">${escapeHtml(request.requesterName)} さんから確認依頼</div>
      <div class="desktop-request-item-meta">${escapeHtml(request.ownerName)} / ${escapeHtml(request.startDate)} / ${request.repeatDays}日分</div>
      <div class="desktop-request-item-meta">送信日時: ${escapeHtml(formatDateTimeLabel(request.createdAt))}</div>
      ${needsHalfDayDecision ? `
        <div class="desktop-request-item-meta">半日休が含まれています。休みの変更は可能ですか？</div>
        <div class="desktop-request-item-actions">
          <button class="btn" type="button" data-request-action="halfday-allow" data-request-id="${escapeHtml(request.id)}">可能（全日上書き）</button>
          <button class="btn btn-secondary" type="button" data-request-action="halfday-deny" data-request-id="${escapeHtml(request.id)}">不可（非休み側のみ）</button>
        </div>
      ` : ""}
      ${needsHalfDayDecision ? "" : `
        <div class="desktop-request-item-actions">
          <button class="btn" type="button" data-request-action="approve" data-request-id="${escapeHtml(request.id)}">承認</button>
          <button class="btn btn-secondary" type="button" data-request-action="reject" data-request-id="${escapeHtml(request.id)}">却下</button>
        </div>
      `}
    </li>
  `;
    })()}
  `).join("");
}

function getPendingIncomingRequests(requests) {
  const currentId = normalizeLoginId(state.currentUserId);
  if (!currentId || !Array.isArray(requests)) {
    return [];
  }
  return requests.filter((item) => item && item.status === "pending" && normalizeLoginId(item.targetId) === currentId);
}

function getPendingOutgoingRequests(requests) {
  const currentId = normalizeLoginId(state.currentUserId);
  if (!currentId || !Array.isArray(requests)) {
    return [];
  }
  return requests.filter((item) => item && item.status === "pending" && normalizeLoginId(item.requesterId) === currentId);
}

async function applyApprovalRequest(request, requestId, currentId, allowHalfDayOverwrite) {
  const repeatDays = Number(request.repeatDays || 1);

  const savedCountOwner = applyApprovedEntryWithRepeat(
    request.ownerName,
    request.startDate,
    request.entryData,
    repeatDays,
    allowHalfDayOverwrite,
  );

  const targetRowName = resolveRowNameByLoginId(
    currentId,
    request.targetName || state.currentUser || currentId,
  );
  let savedCountTarget = 0;
  if (targetRowName && targetRowName !== request.ownerName) {
    savedCountTarget = applyApprovedEntryWithRepeat(
      targetRowName,
      request.startDate,
      request.entryData,
      repeatDays,
      allowHalfDayOverwrite,
    );
  }

  const requesterRowName = resolveRowNameByLoginId(
    normalizeLoginId(request.requesterId),
    request.requesterName || "",
  );
  let savedCountRequester = 0;
  if (requesterRowName && requesterRowName !== request.ownerName && requesterRowName !== targetRowName) {
    savedCountRequester = applyApprovedEntryWithRepeat(
      requesterRowName,
      request.startDate,
      request.entryData,
      repeatDays,
      allowHalfDayOverwrite,
    );
  }

  const savedCount = savedCountOwner + savedCountTarget + savedCountRequester;

  scheduleFinalizeRequired = false;
  removeConfirmationRequest(requestId);
  try {
    await saveStateImmediately();
  } catch (error) {
    setNotice("承認結果の共有に失敗しました。通信状態を確認して再操作してください。");
    return false;
  }
  setNotice(`${request.requesterName} さんの依頼を承認し、${savedCount}件を反映しました。`);
  await render();
  return true;
}

async function handleConfirmationRequestAction(requestId, action) {
  const request = state.confirmationRequests.find((item) => item && item.id === requestId);
  if (!request || request.status !== "pending") {
    return;
  }

  const currentId = normalizeLoginId(state.currentUserId);
  if (!currentId) {
    return;
  }

  if (action === "halfday-allow" || action === "halfday-deny") {
    if (normalizeLoginId(request.targetId) !== currentId) {
      setNotice("この依頼は処理できません。");
      return;
    }

    const targetRowName = resolveRowNameByLoginId(
      currentId,
      request.targetName || state.currentUser || currentId,
    );

    if (hasScheduleConflict(targetRowName, request.startDate, request.repeatDays)) {
      if (!confirm("当初から予定が入っています。変更してもいいですか？")) {
        return;
      }
    }

    const allowHalfDayOverwrite = action === "halfday-allow";
    await applyApprovalRequest(request, requestId, currentId, allowHalfDayOverwrite);
    return;
  }

  if (action === "approve") {
    if (normalizeLoginId(request.targetId) !== currentId) {
      setNotice("この依頼は承認できません。");
      return;
    }

    const targetRowName = resolveRowNameByLoginId(
      currentId,
      request.targetName || state.currentUser || currentId,
    );

    if (hasScheduleConflict(targetRowName, request.startDate, request.repeatDays)) {
      if (!confirm("当初から予定が入っています。変更してもいいですか？")) {
        return;
      }
    }

    await applyApprovalRequest(request, requestId, currentId, true);
    return;
  }

  if (action === "reject") {
    if (normalizeLoginId(request.targetId) !== currentId) {
      setNotice("この依頼は却下できません。");
      return;
    }
    removeConfirmationRequest(requestId);
    try {
      await saveStateImmediately();
    } catch (error) {
      setNotice("却下結果の共有に失敗しました。通信状態を確認して再操作してください。");
      return;
    }
    setNotice(`${request.requesterName} さんの依頼を却下しました。`);
    await render();
    return;
  }

  if (action === "cancel") {
    if (await isConfirmationRequestAlreadyHandled(requestId)) {
      setNotice("この確認依頼は相手側で処理済みです。最新状態に更新しました。");
      await render();
      return;
    }

    if (normalizeLoginId(request.requesterId) !== currentId) {
      setNotice("この依頼は取消できません。");
      return;
    }
    removeConfirmationRequest(requestId);
    try {
      await saveStateImmediately();
    } catch (error) {
      setNotice("取消結果の共有に失敗しました。通信状態を確認して再操作してください。");
      return;
    }
    setNotice("確認依頼を取り消しました。");
    await render();
  }
}

async function isConfirmationRequestAlreadyHandled(requestId) {
  if (!cloudSyncEnabled || !currentFirebaseUser || !firestoreDb) {
    return false;
  }

  try {
    const snapshot = await firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).get();
    if (!snapshot.exists) {
      return false;
    }

    const cloudData = snapshot.data();
    const cloudRequests = Array.isArray(cloudData?.confirmationRequests)
      ? cloudData.confirmationRequests
      : [];
    const cloudRequest = cloudRequests.find((item) => item && item.id === requestId);
    const alreadyHandled = !cloudRequest || cloudRequest.status !== "pending";

    if (alreadyHandled) {
      const mergedCloudData = mergeCloudDataWithPersonalDraft(cloudData);
      applyLoadedData(mergedCloudData, false);
      const remoteUpdatedAt = normalizeTimestamp(cloudData.updatedAt);
      if (remoteUpdatedAt) {
        lastKnownRemoteUpdatedAt = remoteUpdatedAt;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
    }

    return alreadyHandled;
  } catch (error) {
    return false;
  }
}

function removeConfirmationRequest(requestId) {
  state.confirmationRequests = state.confirmationRequests.filter((item) => item && item.id !== requestId);
}

function trimResolvedRequests() {
  const pending = state.confirmationRequests.filter((item) => item && item.status === "pending");
  const resolved = state.confirmationRequests
    .filter((item) => item && item.status !== "pending")
    .sort((a, b) => String(b.resolvedAt || "").localeCompare(String(a.resolvedAt || "")))
    .slice(0, 120);

  state.confirmationRequests = [...pending, ...resolved];
}

function createRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function markScheduleNeedsFinalize() {
  scheduleFinalizeRequired = true;
  syncFinalizeButtonUi();
}

function syncFinalizeButtonUi() {
  if (!refs.finalizeScheduleBtn) {
    return;
  }

  if (finalizeInFlight) {
    refs.finalizeScheduleBtn.disabled = true;
    refs.finalizeScheduleBtn.textContent = "確定通知中...";
    return;
  }

  if (scheduleFinalizeRequired) {
    refs.finalizeScheduleBtn.disabled = false;
    refs.finalizeScheduleBtn.textContent = "入力を確定して通知";
    return;
  }

  refs.finalizeScheduleBtn.disabled = true;
  refs.finalizeScheduleBtn.textContent = "確定済み（変更後に有効）";
}

function bindDragAndDrop(list) {
  if (list.dataset.dndBound === "1") {
    return;
  }
  list.dataset.dndBound = "1";

  let dragSrcIndex = null;
  let dragOverItem = null;

  list.addEventListener("dragstart", (event) => {
    const li = event.target.closest("li[data-index]");
    if (!li) {
      return;
    }
    dragSrcIndex = Number(li.dataset.index);
    li.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });

  list.addEventListener("dragend", () => {
    list.querySelectorAll(".dragging, .drag-over").forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
    dragSrcIndex = null;
    dragOverItem = null;
  });

  list.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const li = event.target.closest("li[data-index]");
    if (!li || li === dragOverItem) {
      return;
    }
    list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    dragOverItem = li;
    li.classList.add("drag-over");
  });

  list.addEventListener("drop", async (event) => {
    event.preventDefault();
    const li = event.target.closest("li[data-index]");
    if (!li || dragSrcIndex === null) {
      return;
    }

    const dropIndex = Number(li.dataset.index);
    if (dragSrcIndex === dropIndex) {
      return;
    }

    const items = state.staffAccounts;
    const [moved] = items.splice(dragSrcIndex, 1);
    items.splice(dropIndex, 0, moved);

    refreshStaffFromAccounts();
    saveState();
    setNotice("表示順を更新しました。");
    await render();
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

function renameManualEntriesByUserName(previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) {
    return;
  }

  const prevPrefix = `${previousName}::`;
  for (const key of Object.keys(state.manualEntries)) {
    if (!key.startsWith(prevPrefix)) {
      continue;
    }

    const dateStr = key.slice(prevPrefix.length);
    const nextKey = `${nextName}::${dateStr}`;
    state.manualEntries[nextKey] = state.manualEntries[key];
    delete state.manualEntries[key];
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
    case "午前有休":
    case "午後有休":
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
      work: "",
      place: "",
      source: "sunday",
    };
  }

  if (isCompanyHoliday(date)) {
    return {
      status: "休み",
      work: "",
      place: "",
      source: "company",
    };
  }

  return null;
}

function openEditDialog(name, dateStr, currentEntry) {
  if (!canEditRow(name) || !refs.editDialog) {
    setNotice("本人の行、または管理者として編集できます。");
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
  if (refs.secondaryStatusInput) {
    const options = HALF_DAY_SECONDARY_STATUS_OPTIONS
      .map((s) => `<option value="${s}">${s}</option>`)
      .join("");
    refs.secondaryStatusInput.innerHTML = `<option value="">選択してください</option>${options}`;
    refs.secondaryStatusInput.value = currentEntry?.secondaryStatus || "";
  }
  if (refs.workInput) {
    refs.workInput.value = currentEntry?.work || "";
  }
  if (refs.placeInput) {
    refs.placeInput.value = currentEntry?.place || "";
  }
  const status = currentEntry?.status || "現場";
  syncHalfDayInputUi(status);
  syncHalfDaySecondaryStatusUi(status);
  if (refs.repeatEnabled) {
    refs.repeatEnabled.checked = false;
  }
  if (refs.repeatCount) {
    refs.repeatCount.value = "1";
  }

  populateRequestTargetOptions(name);
  if (refs.requestConfirmEnabled) {
    refs.requestConfirmEnabled.checked = false;
  }
  if (refs.requestTargetInput) {
    Array.from(refs.requestTargetInput.options).forEach((option) => {
      option.selected = false;
    });
  }
  if (refs.requestMessageInput) {
    refs.requestMessageInput.value = "";
  }
  syncRequestFormUi();

  openDialog(refs.editDialog);
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

  markScheduleNeedsFinalize();

  return count;
}

function applyApprovedEntryWithRepeat(name, startDateStr, entryData, repeatDays, allowHalfDayOverwrite = true) {
  const count = clamp(repeatDays, 1, 12);
  const startDate = fromISODate(startDateStr);

  for (let i = 0; i < count; i += 1) {
    const targetDate = addDays(startDate, i);
    const key = entryKey(name, toISODate(targetDate));
    const currentEntry = state.manualEntries[key];
    state.manualEntries[key] = buildApprovedEntryData(currentEntry, entryData, allowHalfDayOverwrite);
  }

  markScheduleNeedsFinalize();

  return count;
}

function buildApprovedEntryData(currentEntry, requestedEntry, allowHalfDayOverwrite) {
  if (allowHalfDayOverwrite) {
    return {
      ...requestedEntry,
      source: "manual",
      approvedByRequest: true,
      updatedAt: new Date().toISOString(),
    };
  }

  const requestedStatus = normalizeDisplayName(requestedEntry?.status || "");
  const requestedSlot = getHalfDayWorkingSlot(requestedStatus);

  const currentStatus = normalizeDisplayName(currentEntry?.status || "");
  const currentSlot = getHalfDayWorkingSlot(currentStatus);
  if (!currentSlot) {
    return {
      ...requestedEntry,
      source: "manual",
      approvedByRequest: true,
      updatedAt: new Date().toISOString(),
    };
  }

  const currentSecondaryStatus = normalizeDisplayName(currentEntry?.secondaryStatus || "");
  const requestedSecondaryStatus = normalizeDisplayName(requestedEntry?.secondaryStatus || "");

  // 休み側は現状維持し、変更不可時は非休み側のみ上書きする
  let nextSecondaryStatus = currentSecondaryStatus;
  if (requestedSlot) {
    nextSecondaryStatus = requestedSlot === currentSlot
      ? (requestedSecondaryStatus || currentSecondaryStatus)
      : currentSecondaryStatus;
  } else {
    nextSecondaryStatus = requestedStatus || currentSecondaryStatus;
  }

  return {
    ...requestedEntry,
    status: currentStatus,
    secondaryStatus: nextSecondaryStatus,
    source: "manual",
    approvedByRequest: true,
    updatedAt: new Date().toISOString(),
  };
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

function setLoginUiBusy(isBusy) {
  if (refs.loginSubmitBtn) {
    refs.loginSubmitBtn.disabled = Boolean(isBusy);
    refs.loginSubmitBtn.textContent = isBusy ? "ログイン中..." : "ログイン";
  }
}

function handleLoginFailure(message) {
  pendingLoginId = "";
  pendingLoginDisplayName = "";
  pendingLoginPassword = "";
  setNotice(message);
  if (refs.loginPasswordInput) {
    refs.loginPasswordInput.value = "";
    refs.loginPasswordInput.focus();
  }
}

function syncAuthUi() {
  if (!refs.currentUserLabel) {
    return;
  }
  const userLabel = state.currentUser || "未ログイン";
  refs.currentUserLabel.textContent = `ログイン: ${userLabel}${state.isAdmin ? " [管理者]" : ""}`;
}

function syncAdminUi() {
  if (!isOverallPage && !isAdminPage) {
    return;
  }

  const showAdmin = Boolean(state.isAdmin);

  if (refs.adminSettingsSection) {
    refs.adminSettingsSection.classList.toggle("hidden", !showAdmin);
  }
  if (refs.adminRegisterSection) {
    refs.adminRegisterSection.classList.toggle("hidden", !showAdmin);
  }
  if (refs.adminRecoverySection) {
    refs.adminRecoverySection.classList.toggle("hidden", !showAdmin);
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
  return (!isOverallPage && !isAdminPage) || state.isAdmin;
}

function canEditRow(name) {
  if (!currentFirebaseUser) {
    return false;
  }

  if ((isOverallPage || isAdminPage) && state.isAdmin) {
    return true;
  }

  const personalRowName = getPersonalRowName();
  return isPersonalPage && Boolean(personalRowName) && personalRowName === name;
}

function getPersonalRowName() {
  if (!isPersonalPage) {
    return "";
  }

  const loginId = normalizeLoginId(state.currentUserId);
  if (loginId) {
    const account = findAccountByLoginId(loginId);
    if (account?.name) {
      return account.name;
    }
  }

  if (state.currentUser) {
    return state.currentUser;
  }

  return loginId;
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
  let localData = null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      localData = JSON.parse(raw);
      applyLoadedData(localData, true);
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
        const mergedCloudData = mergeCloudDataWithPersonalDraft(cloudData, localData);
        applyLoadedData(mergedCloudData, false);
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
  syncCurrentUserFromLoginId();
}

function saveState(options = {}) {
  const announce = options?.announce === true;
  const localOnly = options?.localOnly === true;
  const forceCloud = options?.forceCloud === true;
  const localPayload = buildLocalPayload();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPayload));
  saveLocalRecoveryBackup(localPayload, "saveState");

  if (localOnly && !forceCloud) {
    return;
  }

  const cloudPayload = buildCloudPayload(announce);
  lastLocalSaveUpdatedAt = normalizeTimestamp(cloudPayload.updatedAt);
  queueCloudSave(cloudPayload);
}

async function saveStateImmediately(options = {}) {
    // --- Firestore自動バックアップ（2週間分のみ保持） ---
    try {
      if (cloudSyncEnabled && currentFirebaseUser && firestoreDb) {
        const backupDate = new Date();
        const backupId = backupDate.toISOString().replace(/[:.]/g, "-");
        const backupRef = firestoreDb.collection("backups").doc(backupId);
        const backupPayload = buildCloudPayload(options?.announce === true);
        // バックアップ保存
        await backupRef.set({
          ...backupPayload,
          backupCreatedAt: backupDate.toISOString(),
          backupBy: state.currentUser || state.currentUserId || "system"
        });
        // 14日より古いバックアップを削除
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const oldBackups = await firestoreDb.collection("backups")
          .where("backupCreatedAt", "<", twoWeeksAgo.toISOString())
          .get();
        oldBackups.forEach(doc => doc.ref.delete());
      }
    } catch (e) {
      // バックアップ失敗時も本処理は継続
    }
  const announce = options?.announce === true;
  const localPayload = buildLocalPayload();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPayload));
  saveLocalRecoveryBackup(localPayload, "saveStateImmediately");

  if (!cloudSyncEnabled || !currentFirebaseUser || !firestoreDb) {
    return;
  }

  const cloudPayload = buildCloudPayload(announce);
  lastLocalSaveUpdatedAt = normalizeTimestamp(cloudPayload.updatedAt);
  await firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT).set(cloudPayload, { merge: true });
  lastKnownRemoteUpdatedAt = normalizeTimestamp(cloudPayload.updatedAt);
}

function saveWeeklyBusinessNotesImmediately() {
  const localPayload = buildLocalPayload();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localPayload));
  saveLocalRecoveryBackup(localPayload, "saveWeeklyBusinessNotesImmediately");

  if (!cloudSyncEnabled || !currentFirebaseUser || !firestoreDb) {
    return;
  }

  const payload = {
    weeklyBusinessNotes: state.weeklyBusinessNotes,
    updatedByName: state.currentUser || (isPersonalPage ? "未ログイン利用者" : "管理画面"),
    updatedById: state.currentUserId || "",
    updatedByPage: pageMode,
    notifyScope: "silent",
    updatedAt: new Date().toISOString(),
  };

  lastLocalSaveUpdatedAt = normalizeTimestamp(payload.updatedAt);

  firestoreDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT)
    .set(payload, { merge: true })
    .then(() => {
      lastKnownRemoteUpdatedAt = normalizeTimestamp(payload.updatedAt);
    })
    .catch(() => {
      setNotice("業務欄の即時反映に失敗しました。再度保存してください。");
    });
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
    confirmationRequests: state.confirmationRequests,
    weeklyBusinessNotes: state.weeklyBusinessNotes,
    progressProjectsByUser: state.progressProjectsByUser,
    finalizeRequired: scheduleFinalizeRequired,
  };
}

function buildCloudPayload(announce = false) {
  return {
    currentWeekStart: toISODate(state.currentWeekStart),
    staff: state.staff,
    staffAccounts: state.staffAccounts,
    manualEntries: state.manualEntries,
    settings: state.settings,
    confirmationRequests: state.confirmationRequests,
    weeklyBusinessNotes: state.weeklyBusinessNotes,
    progressProjectsByUser: state.progressProjectsByUser,
    updatedByName: state.currentUser || (isPersonalPage ? "未ログイン利用者" : "管理画面"),
    updatedById: state.currentUserId || "",
    updatedByPage: pageMode,
    notifyScope: announce ? "announce" : "silent",
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
  if (Array.isArray(data.confirmationRequests)) {
    state.confirmationRequests = data.confirmationRequests;
  }
  if (data.weeklyBusinessNotes && typeof data.weeklyBusinessNotes === "object") {
    state.weeklyBusinessNotes = data.weeklyBusinessNotes;
  }
  if (data.progressProjectsByUser && typeof data.progressProjectsByUser === "object") {
    state.progressProjectsByUser = data.progressProjectsByUser;
  }
  if (typeof data.finalizeRequired === "boolean") {
    scheduleFinalizeRequired = data.finalizeRequired;
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

function mergeCloudDataWithPersonalDraft(cloudData, draftData = null) {
  if (!isPersonalPage || !scheduleFinalizeRequired || !cloudData || typeof cloudData !== "object") {
    return cloudData;
  }

  const personalName = getPersonalRowName();
  if (!personalName) {
    return cloudData;
  }

  const cloudEntries = cloudData.manualEntries && typeof cloudData.manualEntries === "object"
    ? cloudData.manualEntries
    : {};
  const draftEntriesSource = draftData?.manualEntries && typeof draftData.manualEntries === "object"
    ? draftData.manualEntries
    : state.manualEntries;

  const prefix = `${personalName}::`;
  const mergedEntries = { ...cloudEntries };

  for (const key of Object.keys(mergedEntries)) {
    if (key.startsWith(prefix)) {
      delete mergedEntries[key];
    }
  }

  // 個人ページの下書きを優先しつつ、承認済み反映(approvedByRequest)はクラウドを優先する。
  const personalKeys = new Set();
  for (const key of Object.keys(cloudEntries)) {
    if (key.startsWith(prefix)) {
      personalKeys.add(key);
    }
  }
  if (draftEntriesSource && typeof draftEntriesSource === "object") {
    for (const key of Object.keys(draftEntriesSource)) {
      if (key.startsWith(prefix)) {
        personalKeys.add(key);
      }
    }
  }

  for (const key of personalKeys) {
    const cloudEntry = cloudEntries[key];
    const draftEntry = draftEntriesSource?.[key];

    if (cloudEntry?.approvedByRequest === true) {
      mergedEntries[key] = cloudEntry;
      continue;
    }

    if (draftEntry !== undefined) {
      mergedEntries[key] = draftEntry;
      continue;
    }

    if (cloudEntry !== undefined) {
      mergedEntries[key] = cloudEntry;
    }
  }

  return {
    ...cloudData,
    manualEntries: mergedEntries,
    currentWeekStart: draftData?.currentWeekStart || cloudData.currentWeekStart,
  };
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
  const incomingRequests = getPendingIncomingRequests(cloudData.confirmationRequests);
  const incomingCount = incomingRequests.length;
  if (incomingCount > 0) {
    const incomingSignature = incomingRequests
      .map((item) => String(item?.id || ""))
      .filter(Boolean)
      .sort()
      .join("|");

    if (incomingSignature && incomingSignature === lastIncomingRequestSignature) {
      return;
    }
    lastIncomingRequestSignature = incomingSignature;

    const msg = `確認依頼が${incomingCount}件あります。確認依頼セクションを確認してください。`;
    showSyncAlert(msg);
    setNotice(msg);
    if (requestNotificationEnabled && window.Notification && Notification.permission === "granted") {
      try {
        new Notification("確認依頼が届きました", {
          body: `承認待ちの依頼が${incomingCount}件あります。`,
        });
      } catch (error) {
        // ブラウザ通知不可時は画面内通知のみ継続
      }
    }
    return;
  }

  // 承認待ちがなくなったら、次の新着通知を出せるようにリセット
  lastIncomingRequestSignature = "";

  if (!scheduleNotificationEnabled) {
    return;
  }

  if (cloudData?.notifyScope === "silent") {
    return;
  }

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

function isOwnCloudUpdate(cloudData) {
  const currentId = normalizeLoginId(state.currentUserId);
  const updaterId = normalizeLoginId(cloudData?.updatedById || "");
  if (currentId && updaterId && currentId === updaterId) {
    return true;
  }

  const currentName = normalizeDisplayName(state.currentUser || "");
  const updaterName = normalizeDisplayName(cloudData?.updatedByName || "");
  return Boolean(currentName && updaterName && currentName === updaterName && cloudData?.updatedByPage === pageMode);
}

function loadNotificationPreferences() {
  try {
    const scheduleRaw = localStorage.getItem(SCHEDULE_NOTIFICATION_PREFERENCE_KEY);
    scheduleNotificationEnabled = scheduleRaw === null ? true : scheduleRaw !== "0";

    const requestRaw = localStorage.getItem(REQUEST_NOTIFICATION_PREFERENCE_KEY);
    requestNotificationEnabled = requestRaw === null ? true : requestRaw !== "0";
  } catch (error) {
    scheduleNotificationEnabled = true;
    requestNotificationEnabled = true;
  }
}

function saveNotificationPreferences() {
  try {
    localStorage.setItem(SCHEDULE_NOTIFICATION_PREFERENCE_KEY, scheduleNotificationEnabled ? "1" : "0");
    localStorage.setItem(REQUEST_NOTIFICATION_PREFERENCE_KEY, requestNotificationEnabled ? "1" : "0");
  } catch (error) {
    // localStorage が使えない環境ではメモリ上の設定のみ使う
  }
}

function setScheduleNotificationEnabled(enabled) {
  scheduleNotificationEnabled = !!enabled;
  saveNotificationPreferences();
  syncNotificationUi();
}

function setRequestNotificationEnabled(enabled) {
  requestNotificationEnabled = !!enabled;
  saveNotificationPreferences();
  syncNotificationUi();

  if (requestNotificationEnabled) {
    ensureBackgroundPushSubscription().catch(() => {
      // 失敗時も画面内通知は継続
    });
    return;
  }

  removePushTokenRegistration().catch(() => {
    // 失敗時も画面内通知は継続
  });
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
  if (!refs.notificationStatus || !refs.enableNotificationsBtn || !refs.toggleScheduleNotificationsBtn || !refs.toggleRequestNotificationsBtn) {
    return;
  }

  if (!("Notification" in window)) {
    refs.notificationStatus.textContent = "端末通知: このブラウザは未対応";
    refs.enableNotificationsBtn.textContent = "通知未対応";
    refs.enableNotificationsBtn.disabled = true;
    refs.toggleScheduleNotificationsBtn.textContent = "更新通知: 未対応";
    refs.toggleRequestNotificationsBtn.textContent = "確認依頼通知: 未対応";
    refs.toggleScheduleNotificationsBtn.disabled = true;
    refs.toggleRequestNotificationsBtn.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    refs.notificationStatus.textContent = "端末通知: 許可済み";
    refs.enableNotificationsBtn.textContent = "端末通知を再確認";
    refs.enableNotificationsBtn.disabled = false;
    refs.toggleScheduleNotificationsBtn.textContent = scheduleNotificationEnabled
      ? "更新通知を無効にする"
      : "更新通知を有効にする";
    refs.toggleRequestNotificationsBtn.textContent = requestNotificationEnabled
      ? "確認依頼通知を無効にする"
      : "確認依頼通知を有効にする";
    refs.toggleScheduleNotificationsBtn.disabled = false;
    refs.toggleRequestNotificationsBtn.disabled = false;
    return;
  }

  if (Notification.permission === "denied") {
    refs.notificationStatus.textContent = "端末通知: ブロックされています";
    refs.enableNotificationsBtn.textContent = "通知設定を確認";
    refs.enableNotificationsBtn.disabled = true;
    refs.toggleScheduleNotificationsBtn.textContent = "更新通知を有効にする";
    refs.toggleRequestNotificationsBtn.textContent = "確認依頼通知を有効にする";
    refs.toggleScheduleNotificationsBtn.disabled = true;
    refs.toggleRequestNotificationsBtn.disabled = true;
    return;
  }

  refs.notificationStatus.textContent = "端末通知: 未設定";
  refs.enableNotificationsBtn.textContent = "通知を有効にする";
  refs.enableNotificationsBtn.disabled = false;
  refs.toggleScheduleNotificationsBtn.textContent = scheduleNotificationEnabled
    ? "更新通知を無効にする"
    : "更新通知を有効にする";
  refs.toggleRequestNotificationsBtn.textContent = requestNotificationEnabled
    ? "確認依頼通知を無効にする"
    : "確認依頼通知を有効にする";
  refs.toggleScheduleNotificationsBtn.disabled = true;
  refs.toggleRequestNotificationsBtn.disabled = true;
}

async function requestBrowserNotificationPermission() {
  if (!("Notification" in window)) {
    setNotice("このブラウザでは端末通知を利用できません。");
    syncNotificationUi();
    return;
  }

  if (Notification.permission === "granted") {
    syncNotificationUi();
    setNotice("端末通知は許可済みです。更新通知・確認依頼通知は個別ボタンで切り替えてください。");
    return;
  }

  const permission = await Notification.requestPermission();
  syncNotificationUi();

  if (permission === "granted") {
    setScheduleNotificationEnabled(true);
    setRequestNotificationEnabled(true);
    await ensureBackgroundPushSubscription();
    setNotice("端末通知を有効にしました。他の利用者の更新時に通知します。確認依頼はPush通知でも受信できます。");
    return;
  }

  setNotice("端末通知は有効化されませんでした。画面内通知は引き続き表示されます。");
}

function getPushNotifyEndpoint() {
  return String(window.__PUSH_NOTIFY_ENDPOINT__ || "").trim();
}

function getFirebaseVapidKey() {
  return String(window.__FIREBASE_VAPID_KEY__ || "").trim();
}

function canUseBackgroundPush() {
  return Boolean(
    firebaseMessaging
    && window.isSecureContext
    && "serviceWorker" in navigator
    && "PushManager" in window,
  );
}

async function ensureBackgroundPushSubscription() {
  if (!canUseBackgroundPush() || !cloudSyncEnabled || !currentFirebaseUser || !firestoreDb) {
    return;
  }

  const vapidKey = getFirebaseVapidKey();
  if (!vapidKey) {
    return;
  }

  const registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
  await navigator.serviceWorker.ready;

  const token = await firebaseMessaging.getToken({
    vapidKey,
    serviceWorkerRegistration: registration,
  });

  if (!token) {
    return;
  }

  currentPushToken = token;
  localStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);

  await firestoreDb.collection(PUSH_TOKEN_COLLECTION).doc(token).set({
    token,
    loginId: normalizeLoginId(state.currentUserId),
    userName: normalizeDisplayName(state.currentUser || ""),
    uid: String(currentFirebaseUser.uid || ""),
    enabled: Boolean(requestNotificationEnabled),
    updatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  }, { merge: true });
}

async function removePushTokenRegistration() {
  if (!firestoreDb || !cloudSyncEnabled) {
    currentPushToken = "";
    localStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
    return;
  }

  const token = currentPushToken || String(localStorage.getItem(PUSH_TOKEN_STORAGE_KEY) || "").trim();
  currentPushToken = "";
  localStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
  if (!token) {
    return;
  }

  try {
    await firestoreDb.collection(PUSH_TOKEN_COLLECTION).doc(token).delete();
  } catch (error) {
    // 未登録時は無視
  }
}

function triggerServerPushForConfirmationRequest(request) {
  const endpoint = getPushNotifyEndpoint();
  if (!endpoint || !request || typeof request !== "object") {
    return;
  }

  const payload = {
    type: "confirmation-request",
    requestId: String(request.id || ""),
    targetId: normalizeLoginId(request.targetId || ""),
    targetName: normalizeDisplayName(request.targetName || ""),
    requesterId: normalizeLoginId(request.requesterId || ""),
    requesterName: normalizeDisplayName(request.requesterName || ""),
    ownerName: normalizeDisplayName(request.ownerName || ""),
    startDate: String(request.startDate || ""),
    repeatDays: Number(request.repeatDays || 1),
    message: normalizeDisplayName(request.message || ""),
    createdAt: String(request.createdAt || new Date().toISOString()),
  };

  fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Push送信失敗時もFirestore上の確認依頼は保持される
  });
}

async function handleAuthStateChanged(user) {
  currentFirebaseUser = user;

  if (!user) {
    if (isAdminPage) {
      // 管理者ページで未ログイン状態になった場合は通常ログイン導線へ戻す
      window.location.href = "overall.html";
      return;
    }

    stopCloudListener();
    state.currentUser = "";
    state.currentUserId = "";
    state.isAdmin = false;
    state.editTarget = null;
    pendingLoginId = "";
    pendingLoginDisplayName = "";
    pendingLoginPassword = "";
    await removePushTokenRegistration();
    updatePageLock();
    syncAuthUi();
    syncAdminUi();
    syncLoginForm();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
    if (requiresAuth && refs.loginDialog) {
      openDialog(refs.loginDialog);
    }
    setNotice("ログアウトしました。ログイン後に利用できます。");
    return;
  }

  const authLoginId = getLoginIdFromAuthUser(user);
  const cachedProfile = getAuthProfile(user);
  const authAccount = authLoginId ? findAccountByLoginId(authLoginId) : null;
  if (authLoginId && (authAccount || isAdminLoginId(authLoginId))) {
    state.currentUserId = authLoginId;
    state.currentUser = authAccount?.name || authLoginId;
  } else if (pendingLoginId) {
    state.currentUserId = pendingLoginId;
    state.currentUser = pendingLoginDisplayName || pendingLoginId;
  } else if (cachedProfile?.loginId) {
    state.currentUserId = normalizeLoginId(cachedProfile.loginId);
    state.currentUser = normalizeDisplayName(cachedProfile.displayName || cachedProfile.loginId);
  }

  syncCurrentUserFromLoginId();
  if (pendingLoginPassword) {
    const account = findAccountByLoginId(state.currentUserId);
    if (account && normalizeLoginPassword(account.password || "") !== pendingLoginPassword) {
      account.password = pendingLoginPassword;
      saveState();
    }
  }
  syncAuthProfileDisplayName(user, state.currentUserId);

  state.isAdmin = await detectAdminUser(user);
  const currentUserAddedToStaff = ensureCurrentUserInStaffAccounts();
  setAuthProfile(user, state.currentUserId, state.currentUser);
  pendingLoginId = "";
  pendingLoginDisplayName = "";
  pendingLoginPassword = "";

  // 管理者は管理者ページのみ、非管理者は管理者ページに入れない
  if (state.isAdmin && !isAdminPage) {
    window.location.href = "admin.html";
    return;
  }
  if (!state.isAdmin && isAdminPage) {
    window.location.href = "overall.html";
    return;
  }

  updatePageLock();
  syncAuthUi();
  syncAdminUi();
  syncLoginForm();
  if (refs.loginDialog?.open) {
    closeDialog(refs.loginDialog);
  }
  startCloudListener();
  if (requestNotificationEnabled && window.Notification && Notification.permission === "granted") {
    await ensureBackgroundPushSubscription();
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalPayload()));
  if (currentUserAddedToStaff && hasMeaningfulScheduleData()) {
    saveState();
  }
  const signedInLabel = state.currentUser || state.currentUserId || "利用者";
  setNotice(`${signedInLabel}${state.isAdmin ? "（管理者）" : ""}でログインしました。`);
  await render();
}

async function detectAdminUser(user) {
  if (!user || !firebaseAuth) {
    return false;
  }

  const authLoginId = normalizeLoginId(getLoginIdFromAuthUser(user));
  if (isAdminLoginId(authLoginId)) {
    return true;
  }

  if (isAdminLoginId(state.currentUserId)) {
    return true;
  }

  if (isAdminLoginId(pendingLoginId)) {
    return true;
  }

  const userEmail = String(user.email || "").toLowerCase();
  const adminAuthEmails = new Set(buildAdminAuthEmailCandidates().map((email) => String(email).toLowerCase()));
  if (adminAuthEmails.has(userEmail)) {
    return true;
  }

  try {
    const tokenResult = await user.getIdTokenResult();
    return tokenResult?.claims?.admin === true;
  } catch (error) {
    return false;
  }
}

function isAdminLoginId(loginId) {
  const normalized = normalizeLoginId(loginId);
  if (!normalized) {
    return false;
  }
  return getAdminLoginIdCandidates().includes(normalized);
}

function getAdminLoginIdCandidates() {
  return [...new Set([ADMIN_LOGIN_ID, ...ADMIN_LOGIN_ID_ALIASES].map((value) => normalizeLoginId(value)).filter((value) => Boolean(value)))];
}

async function ensureAdminAccount(loginId, loginPassword) {
  if (!firebaseAuth || !isAdminCredential(loginId, loginPassword)) {
    return;
  }

  // 管理者は専用の内部メールを優先し、ID名との衝突を避ける
  for (const email of buildAdminAuthEmailCandidates()) {
    try {
      await firebaseAuth.createUserWithEmailAndPassword(email, ADMIN_PASSWORD);
      await firebaseAuth.signOut();
      return;
    } catch (error) {
      const code = error?.code || "";
      if (code === "auth/email-already-in-use") {
        continue;
      }
      // 予期しないエラーはコンソールに残すだけで処理を止めない
      console.warn("ensureAdminAccount:", code);
      return;
    }
  }
}

function isAdminCredential(loginId, loginPassword) {
  return isAdminLoginId(loginId)
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

async function changeUserPasswordWithoutSwitchingSession(loginId, currentPassword, newPassword) {
  const config = window.__FIREBASE_CONFIG__;
  const secondaryName = `password-change-${Date.now()}`;
  const secondaryApp = window.firebase.initializeApp(config, secondaryName);

  try {
    const secondaryAuth = secondaryApp.auth();
    const candidates = buildAuthEmailCandidates(loginId);
    let lastError = null;

    for (const email of candidates) {
      try {
        await secondaryAuth.signInWithEmailAndPassword(email, currentPassword);
        break;
      } catch (error) {
        lastError = error;
        const code = error?.code || "";
        if (
          code === "auth/user-not-found"
          || code === "auth/invalid-credential"
          || code === "auth/invalid-login-credentials"
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!secondaryAuth.currentUser) {
      throw lastError || new Error("password-change-sign-in-failed");
    }

    await secondaryAuth.currentUser.updatePassword(newPassword);
  } finally {
    try {
      await secondaryApp.auth().signOut();
    } catch (error) {
      // no-op
    }
    await secondaryApp.delete();
  }
}

function stopCloudListener() {
  if (cloudUnsubscribe) {
    cloudUnsubscribe();
    cloudUnsubscribe = null;
  }

  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }

  lastKnownRemoteUpdatedAt = "";
  lastLocalSaveUpdatedAt = "";
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
        await signInWithLoginId(loginId, loginPassword);
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
  // Firebase v9+ では auth/invalid-login-credentials に統合された
  return (
    code === "auth/user-not-found" ||
    code === "auth/invalid-credential" ||
    code === "auth/invalid-login-credentials" ||
    code === "auth/user-disabled"
  );
}

function buildAuthEmail(loginId) {
  return `${encodeLoginIdForEmail(loginId)}@${AUTH_EMAIL_DOMAIN}`;
}

function buildAdminAuthEmailCandidates() {
  return [
    `${ADMIN_AUTH_LOCAL_PART}@${AUTH_EMAIL_DOMAIN}`,
    ...getAdminLoginIdCandidates().map((loginId) => buildAuthEmail(loginId)),
  ];
}

function buildAuthEmailCandidates(loginId) {
  const normalized = normalizeLoginId(loginId);
  if (!normalized) {
    return [];
  }

  const candidates = isAdminLoginId(normalized)
    ? [...buildAdminAuthEmailCandidates(), ...[
      `${encodeLoginIdForEmail(normalized)}@${AUTH_EMAIL_DOMAIN}`,
      `${encodeURIComponent(normalized)}@${AUTH_EMAIL_DOMAIN}`,
      `${normalized}@${AUTH_EMAIL_DOMAIN}`,
    ]]
    : [
    `${encodeLoginIdForEmail(normalized)}@${AUTH_EMAIL_DOMAIN}`,
    `${encodeURIComponent(normalized)}@${AUTH_EMAIL_DOMAIN}`,
    `${normalized}@${AUTH_EMAIL_DOMAIN}`,
  ];

  return [...new Set(candidates)].filter((email) => isValidAuthEmail(email));
}

function isValidAuthEmail(email) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(email || ""));
}

async function signInWithLoginId(loginId, loginPassword) {
  if (!firebaseAuth) {
    throw new Error("firebaseAuth is not initialized");
  }

  const candidates = buildAuthEmailCandidates(loginId);
  const allowLegacyFallback = shouldTryLegacyEmailFallback(loginId, loginPassword);
  let lastError = null;

  for (const email of candidates) {
    try {
      return await firebaseAuth.signInWithEmailAndPassword(email, loginPassword);
    } catch (error) {
      lastError = error;
      const code = error?.code || "";

      // ユーザー未登録時のみ次候補へ進む。
      // invalid-login-credentials は誤パスワードでも発生するため無条件で続行すると
      // 短時間で試行回数が増えて auth/too-many-requests を誘発しやすい。
      if (code === "auth/user-not-found") {
        continue;
      }

      // 旧形式メールの後方互換は、ローカル既知パスワード一致時のみ許可して総試行数を抑える。
      if (
        allowLegacyFallback &&
        (code === "auth/invalid-credential" || code === "auth/invalid-login-credentials")
      ) {
        continue;
      }

      // それ以外は即時失敗とみなす
      throw error;
    }
  }

  throw lastError || new Error("sign-in failed");
}

function shouldTryLegacyEmailFallback(loginId, loginPassword) {
  if (isAdminLoginId(loginId)) {
    return true;
  }

  const account = findAccountByLoginId(loginId);
  if (!account) {
    return false;
  }

  return normalizeLoginPassword(account.password || "") === normalizeLoginPassword(loginPassword);
}

function getLoginIdFromAuthUser(user) {
  const profileLoginId = normalizeLoginId(user?.displayName || "");
  if (profileLoginId) {
    return profileLoginId;
  }

  const email = String(user?.email || "");
  if (!email.includes("@")) {
    return "";
  }

  const localPart = email.split("@")[0] || "";
  const decoded = decodeLoginIdFromEmailLocal(localPart);
  if (decoded && !containsReplacementChar(decoded) && isKnownLoginId(decoded)) {
    return normalizeLoginId(decoded);
  }

  const mapped = findLoginIdByAuthLocalPart(localPart);
  if (mapped) {
    return mapped;
  }

  try {
    const decodedUri = decodeURIComponent(localPart);
    if (decodedUri && !containsReplacementChar(decodedUri) && isKnownLoginId(decodedUri)) {
      return normalizeLoginId(decodedUri);
    }
  } catch (error) {
    // legacy形式でURIエンコードされていない場合は無視
  }

  // 既存データと一致確認できない場合の最後の後方互換フォールバック
  if (decoded && !containsReplacementChar(decoded)) {
    return normalizeLoginId(decoded);
  }

  return "";
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

function findLoginIdByAuthLocalPart(localPart) {
  if (!localPart) {
    return "";
  }

  const normalizedLocal = normalizeLoginId(localPart);
  const normalizedLocalLower = normalizedLocal.toLowerCase();
  for (const account of state.staffAccounts) {
    const accountId = normalizeLoginId(account.id);
    if (!accountId) {
      continue;
    }

    const encoded = encodeLoginIdForEmail(accountId);
    if (encoded === localPart || encoded.toLowerCase() === normalizedLocalLower) {
      return accountId;
    }

    const encodedUri = encodeURIComponent(accountId);
    if (encodedUri === localPart || encodedUri.toLowerCase() === normalizedLocalLower) {
      return accountId;
    }

    if (accountId === normalizedLocal || accountId.toLowerCase() === normalizedLocalLower) {
      return accountId;
    }
  }

  return "";
}

function isKnownLoginId(value) {
  const normalized = normalizeLoginId(value);
  if (!normalized) {
    return false;
  }
  if (isAdminLoginId(normalized)) {
    return true;
  }
  return state.staffAccounts.some((account) => normalizeLoginId(account.id) === normalized);
}

function containsReplacementChar(value) {
  return String(value).includes("�");
}

function loadAuthProfileMap() {
  try {
    const raw = localStorage.getItem(AUTH_PROFILE_MAP_KEY);
    if (!raw) {
      authProfileMap = {};
      return;
    }

    const parsed = JSON.parse(raw);
    authProfileMap = parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    authProfileMap = {};
  }
}

function saveAuthProfileMap() {
  localStorage.setItem(AUTH_PROFILE_MAP_KEY, JSON.stringify(authProfileMap));
}

function getAuthProfile(user) {
  const key = String(user?.uid || user?.email || "");
  if (!key) {
    return null;
  }
  return authProfileMap[key] || null;
}

function setAuthProfile(user, loginId, displayName) {
  const key = String(user?.uid || user?.email || "");
  const normalizedId = normalizeLoginId(loginId);
  if (!key || !normalizedId) {
    return;
  }

  authProfileMap[key] = {
    loginId: normalizedId,
    displayName: normalizeDisplayName(displayName || normalizedId),
    updatedAt: new Date().toISOString(),
  };
  saveAuthProfileMap();
}

function syncAuthProfileDisplayName(user, loginId) {
  const normalizedId = normalizeLoginId(loginId);
  if (!user || !normalizedId || user.displayName === normalizedId) {
    return;
  }

  user.updateProfile({ displayName: normalizedId }).catch(() => {
    // profile更新不可でも認証処理は継続する
  });
}

function convertFirebaseAuthError(error) {
  const code = error?.code || "";
  switch (code) {
    case "auth/invalid-login-credentials":
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "ログイン失敗: IDが未登録、またはパスワードが違います。新しいPCでは最初に管理者で利用者登録を確認してください。";
    case "auth/invalid-email":
      return "ログイン失敗: ID形式が不正です。IDに不要な空白がないか確認してください。";
    case "auth/too-many-requests":
      return "ログイン試行回数が多すぎます。しばらく待ってから再試行してください。";
    case "auth/operation-not-allowed":
      return "Firebase Authentication のメール/パスワード認証が無効です。Firebase Consoleで有効化してください。";
    case "auth/invalid-api-key":
      return "Firebase APIキーが無効です。firebase-config.js の設定を確認してください。";
    case "auth/email-already-in-use":
      return "この名前(ID)はすでに登録されています。";
    case "auth/weak-password":
      return "パスワードは任意の8桁の数字で入力してください。";
    case "auth/network-request-failed":
      return "通信に失敗しました。ネットワークを確認してください。";
    default:
      return `Firebase Authentication の処理に失敗しました。(${code || "unknown"})`;
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

function formatDateTimeLabel(value) {
  if (!value) {
    return "不明";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "不明";
  }

  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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

function resolveRowNameByLoginId(loginId, fallbackName = "") {
  const normalizedId = normalizeLoginId(loginId);
  const account = findAccountByLoginId(normalizedId);
  const accountName = normalizeDisplayName(account?.name || "");
  if (accountName) {
    return accountName;
  }

  const fallback = normalizeDisplayName(fallbackName || "");
  if (fallback) {
    return fallback;
  }

  return normalizeDisplayName(normalizedId || "");
}

function findLoginIdByUserName(name) {
  const account = state.staffAccounts.find((item) => item.name === name);
  return account?.id || "";
}

function syncCurrentUserFromLoginId() {
  const loginId = normalizeLoginId(state.currentUserId);
  if (!loginId) {
    return;
  }

  const account = findAccountByLoginId(loginId);
  if (account?.name) {
    state.currentUser = account.name;
    return;
  }

  if (!state.currentUser) {
    state.currentUser = loginId;
  }
}

function refreshStaffFromAccounts() {
  const names = state.staffAccounts.map((item) => item.name).filter((name) => Boolean(name));
  state.staff = [...new Set(names)];
}

function ensureCurrentUserInStaffAccounts() {
  const loginId = normalizeLoginId(state.currentUserId);
  if (!loginId || isAdminLoginId(loginId)) {
    return false;
  }

  if (findAccountByLoginId(loginId)) {
    return false;
  }

  const displayName = normalizeDisplayName(state.currentUser || loginId) || loginId;
  state.staffAccounts.push(toStaffAccount({ id: loginId, name: displayName }));
  refreshStaffFromAccounts();
  state.currentUser = displayName;
  return true;
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

function getMonthStart(baseDate) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return getMonthStart(d);
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

// Function to log in using only a username
async function loginWithUsernameOnly(username, password) {
    const db = firebase.firestore();
    try {
        // Search for the user by username
        const userSnapshot = await db.collection('users').where('username', '==', username).get();
        if (userSnapshot.empty) {
            throw new Error('ユーザー名が見つかりません');
        }

        // Retrieve the user data
        const userData = userSnapshot.docs[0].data();
        const storedPassword = userData.password; // Password stored in Firestore

        // Check if the password matches
        if (storedPassword !== password) {
            throw new Error('パスワードが正しくありません');
        }

        console.log('ログイン成功');
        alert('ログイン成功しました');
    } catch (error) {
        console.error('ログインエラー:', error.message);
        alert('ログインに失敗しました: ' + error.message);
    }
}
