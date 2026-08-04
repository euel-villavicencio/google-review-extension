import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2,
  Clipboard,
  BarChart3,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Settings,
  TriangleAlert,
} from "lucide-react";
import "./styles.css";

const defaults = {
  backendUrl: "https://greview.koyeb.app/",
  crmOrgId: "",
  apiKey: "",
  reviewOpenSyncUrl: "",
  urlSlug: "",
  defaultModule: "Leads",
  googleReviewLink: "",
  generateModule: "Leads",
  generateRecordId: "",
  followUpDays: "7",
};

const productionBackendUrl = "https://greview.koyeb.app/";
const backendAccessKey = "googlereviewlinktracker__Backend_Access_Key";
const reviewOpenSyncUrl = "googlereviewlinktracker__Review_Open_Sync_URL";

const errorMessages = {
  days_must_be_a_positive_number: "Enter a valid number of days.",
  default_module_api_name_must_be_Leads_or_Contacts:
    "Choose either Leads or Contacts as the default module.",
  google_review_link_must_be_a_google_https_url:
    "Enter a valid Google HTTPS review page URL.",
  internal_server_error:
    "Something went wrong on the review tracking server. Please try again.",
  invalid_credentials:
    "The server connection key does not match this Zoho organisation. Reinstall the extension or reset this organisation on the server.",
  invalid_crm_record_id: "Enter a valid Zoho record ID.",
  invalid_json: "The request could not be read. Please try again.",
  missing_x_api_key:
    "The server connection key was not found. Reinstall or update the extension setup.",
  missing_x_crm_org_id:
    "Zoho organisation ID was not detected. Reopen this widget inside Zoho CRM.",
  module_api_name_must_be_Leads_or_Contacts: "Choose either Leads or Contacts.",
  not_found: "The requested review link was not found.",
  review_open_sync_url_must_be_a_zoho_https_function_url:
    "The Zoho review-open sync URL is invalid. Reinstall or update the extension setup.",
  unknown_org_slug: "This business slug is not configured.",
  url_slug_already_taken:
    "This business slug is already in use. Try another one.",
  url_slug_must_use_lowercase_letters_numbers_and_hyphens:
    "Use only lowercase letters, numbers, and hyphens for the organisation slug.",
};

function App() {
  const dashboardOnly =
    window.location.pathname.endsWith("/dashboard.html") ||
    new URLSearchParams(window.location.search).get("view") === "dashboard";
  const [config, setConfig] = useState(loadLocalConfig);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(null);
  const [generatedLink, setGeneratedLink] = useState("");
  const [followUps, setFollowUps] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [recordContext, setRecordContext] = useState(null);
  const autoGenerateStarted = useRef(false);
  const autoDashboardStarted = useRef(false);

  const linkPreview = useMemo(() => {
    const base = normalizeBaseUrl(config.backendUrl) || productionBackendUrl;
    return `${base}/${config.urlSlug || "org-slug"}/${config.defaultModule}/CRM_RECORD_ID`;
  }, [config.backendUrl, config.urlSlug, config.defaultModule]);

  useEffect(() => {
    localStorage.setItem(
      "google-review-settings",
      JSON.stringify({
        backendUrl: productionBackendUrl,
        urlSlug: config.urlSlug,
        defaultModule: config.defaultModule,
        googleReviewLink: config.googleReviewLink,
        followUpDays: config.followUpDays,
      }),
    );
  }, [config]);

  useEffect(() => {
    if (window.ZOHO?.embeddedApp) {
      window.ZOHO.embeddedApp.on("PageLoad", function (data) {
        const crmOrgId = extractZohoOrgId(data);
        if (crmOrgId) {
          setConfig((current) => ({ ...current, crmOrgId }));
        }

        const context = normalizeZohoContext(data);
        if (context) {
          setRecordContext(context);
          setConfig((current) => ({
            ...current,
            generateModule: context.moduleApiName,
            generateRecordId: context.recordId,
          }));
        }
      });
      Promise.resolve(window.ZOHO.embeddedApp.init()).then(() => {
        hydrateZohoOrgId();
        hydrateBackendAccessKey();
        hydrateReviewOpenSyncUrl();
      });
    }
  }, []);

  useEffect(() => {
    function handleOrgDetected(event) {
      const crmOrgId = String(event.detail || "").trim();
      if (!crmOrgId) return;
      setConfig((current) => ({ ...current, crmOrgId }));
    }

    window.addEventListener("google-review-org-detected", handleOrgDetected);
    return () =>
      window.removeEventListener(
        "google-review-org-detected",
        handleOrgDetected,
      );
  }, []);

  useEffect(() => {
    function handleOpenSyncUrlDetected(event) {
      const reviewOpenSyncUrl = String(event.detail || "").trim();
      if (!reviewOpenSyncUrl) return;
      setConfig((current) => ({ ...current, reviewOpenSyncUrl }));
    }

    window.addEventListener(
      "google-review-open-sync-url-detected",
      handleOpenSyncUrlDetected,
    );
    return () =>
      window.removeEventListener(
        "google-review-open-sync-url-detected",
        handleOpenSyncUrlDetected,
      );
  }, []);

  useEffect(() => {
    function handleAccessKeyDetected(event) {
      const apiKey = String(event.detail || "").trim();
      if (!apiKey) return;
      setConfig((current) => ({ ...current, apiKey }));
    }

    window.addEventListener(
      "google-review-api-key-detected",
      handleAccessKeyDetected,
    );
    return () =>
      window.removeEventListener(
        "google-review-api-key-detected",
        handleAccessKeyDetected,
      );
  }, []);

  useEffect(() => {
    if (
      !recordContext ||
      !config.crmOrgId ||
      !config.apiKey ||
      autoGenerateStarted.current
    ) {
      return;
    }
    autoGenerateStarted.current = true;
    generateReviewLinkForRecord(
      recordContext.moduleApiName,
      recordContext.recordId,
      {
        successMessage: "Review link written to this record.",
      },
    );
  }, [recordContext, config.crmOrgId, config.apiKey]);

  useEffect(() => {
    if (
      !dashboardOnly ||
      !config.crmOrgId ||
      !config.apiKey ||
      autoDashboardStarted.current
    ) {
      return;
    }
    autoDashboardStarted.current = true;
    loadDashboard();
  }, [dashboardOnly, config.crmOrgId, config.apiKey]);

  function updateConfig(key, value) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function saveSettings(event) {
    event.preventDefault();
    setBusy("save");
    setMessage(null);

    try {
      if (!config.reviewOpenSyncUrl?.trim()) {
        throw new Error(
          "The Zoho review-open sync URL was not found. Run the extension install action after creating the hidden Review Open Sync URL property.",
        );
      }
      const body = await apiRequest(config, "/org_settings", {
        method: "PUT",
        body: {
          url_slug: config.urlSlug.trim().toLowerCase(),
          google_review_link: config.googleReviewLink.trim(),
          review_open_sync_url: config.reviewOpenSyncUrl.trim(),
          default_module_api_name: config.defaultModule,
        },
      });
      updateConfig("urlSlug", body.url_slug);
      setMessage({
        type: "success",
        text: "Settings saved and ready for link generation.",
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function loadSettings() {
    setBusy("load");
    setMessage(null);

    try {
      const body = await apiRequest(config, "/org_settings");
      setConfig((current) => ({
        ...current,
        urlSlug: body.url_slug || current.urlSlug,
        googleReviewLink: body.google_review_link || current.googleReviewLink,
        defaultModule: body.default_module_api_name || current.defaultModule,
      }));
      setMessage({ type: "success", text: "Current backend settings loaded." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function generateReviewLinkForRecord(
    moduleApiName,
    recordId,
    options = {},
  ) {
    setBusy("generate");
    setGeneratedLink("");
    setMessage(null);

    try {
      const recordName = await getZohoRecordName(moduleApiName, recordId);
      const body = await apiRequest(config, "/review_links", {
        method: "POST",
        body: {
          module_api_name: moduleApiName,
          crm_record_id: recordId,
          crm_record_name: recordName,
        },
      });
      await updateZohoReviewLink(moduleApiName, recordId, body.review_link);
      setGeneratedLink(body.review_link);
      setMessage({
        type: "success",
        text: options.successMessage || "Review link written to Zoho.",
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function generateReviewLink(event) {
    event.preventDefault();
    await generateReviewLinkForRecord(
      config.generateModule,
      config.generateRecordId.trim(),
    );
  }

  async function loadFollowUps() {
    setBusy("followups");
    setFollowUps(null);
    setMessage(null);

    try {
      const days = Math.max(0, Number(config.followUpDays || 0));
      const body = await apiRequest(
        config,
        `/review_links/unopened?days=${encodeURIComponent(days)}`,
      );
      setFollowUps(body);
      setMessage({
        type: "success",
        text: `${body.count} unopened link${body.count === 1 ? "" : "s"} found.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function createFollowUpTasks() {
    setBusy("createFollowups");
    setMessage(null);

    try {
      const days = Math.max(0, Number(config.followUpDays || 0));
      const currentFollowUps =
        followUps ||
        (await apiRequest(
          config,
          `/review_links/unopened?days=${encodeURIComponent(days)}`,
        ));
      const records = currentFollowUps.records || [];
      setFollowUps(currentFollowUps);

      if (records.length === 0) {
        setMessage({
          type: "success",
          text: "No unopened review links need follow-up tasks.",
        });
        return;
      }

      const results = [];
      for (const record of records) {
        try {
          await createZohoFollowUpTask(record);
          results.push({
            module_api_name: record.module_api_name,
            crm_record_id: record.crm_record_id,
            status: "created",
          });
        } catch (error) {
          results.push({
            module_api_name: record.module_api_name,
            crm_record_id: record.crm_record_id,
            status: "failed",
            error: error.message,
          });
        }
      }

      await apiRequest(config, "/review_links/followups/mark_created", {
        method: "POST",
        body: { records: results },
      });

      const createdCount = results.filter(
        (record) => record.status === "created",
      ).length;
      const failedCount = results.length - createdCount;
      const refreshedFollowUps = await apiRequest(
        config,
        `/review_links/unopened?days=${encodeURIComponent(days)}`,
      );
      const refreshedDashboard = await apiRequest(config, "/dashboard/stats");
      setFollowUps(refreshedFollowUps);
      setDashboard(refreshedDashboard);
      setMessage({
        type: failedCount ? "error" : "success",
        text: failedCount
          ? `${createdCount} follow-up task${createdCount === 1 ? "" : "s"} created, ${failedCount} failed.`
          : `${createdCount} follow-up task${createdCount === 1 ? "" : "s"} created.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  async function loadDashboard() {
    setBusy("dashboard");
    setMessage(null);

    try {
      const body = await apiRequest(config, "/dashboard/stats");
      setDashboard(body);
      setMessage({ type: "success", text: "Dashboard refreshed." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  if (dashboardOnly) {
    return (
      <main className="app-shell dashboard-page">
        <header className="app-header dashboard-page-header">
          <div>
            <h1>Google Review Dashboard</h1>
            <p className="subtitle">
              Review-link activity and engagement for this Zoho organisation.
            </p>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={loadDashboard}
            disabled={busy === "dashboard"}
          >
            {busy === "dashboard" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            Refresh Dashboard
          </button>
        </header>

        {message && <StatusMessage type={message.type} text={message.text} />}

        <section className="panel dashboard-panel dashboard-page-panel">
          <DashboardStats data={dashboard} preview={linkPreview} />
        </section>

        <section className="panel dashboard-page-panel">
          <PanelTitle
            icon={Search}
            title="Follow-ups"
            caption="Find generated links that have not been opened and create Zoho Tasks."
          />

          <div className="follow-row">
            <Field label="Days Since Link Generated">
              <input
                value={config.followUpDays}
                onChange={(event) =>
                  updateConfig("followUpDays", event.target.value)
                }
                type="number"
                min="0"
              />
            </Field>
            <button
              type="button"
              onClick={loadFollowUps}
              disabled={busy === "followups"}
            >
              {busy === "followups" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Search size={16} />
              )}
              Load
            </button>
            <button
              type="button"
              className="secondary"
              onClick={createFollowUpTasks}
              disabled={busy === "createFollowups"}
            >
              {busy === "createFollowups" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              Create Tasks
            </button>
          </div>

          <FollowUpList data={followUps} />
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Google Review Link</h1>
          <p className="subtitle">
            Configure review tracking for Zoho CRM Leads and Contacts.
          </p>
        </div>
      </header>

      {message && <StatusMessage type={message.type} text={message.text} />}

      <section className="layout-grid">
        <form className="panel settings-panel" onSubmit={saveSettings}>
          <PanelTitle
            icon={Settings}
            title="Review Settings"
            caption="Set the Google review page and business link slug."
          />

          <Field label="Organisation Slug" span>
            <input
              value={config.urlSlug}
              onChange={(event) => updateConfig("urlSlug", event.target.value)}
              placeholder="business-slug"
              required
            />
          </Field>

          <Field label="Google Review Page URL" span>
            <input
              value={config.googleReviewLink}
              onChange={(event) =>
                updateConfig("googleReviewLink", event.target.value)
              }
              placeholder="Paste the business Google review page URL"
              type="url"
              required
            />
          </Field>

          <div className="button-row">
            <button type="submit" disabled={busy === "save"}>
              {busy === "save" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              Save Settings
            </button>
            <button
              type="button"
              className="secondary"
              onClick={loadSettings}
              disabled={busy === "load"}
            >
              {busy === "load" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <RefreshCw size={16} />
              )}
              Load Current
            </button>
          </div>
        </form>

        <section className="panel">
          <PanelTitle
            icon={ExternalLink}
            title="Review Link Preview"
            caption="Each Lead or Contact gets a unique tracking link."
          />
          <code className="preview-code">{linkPreview}</code>
          <p className="fine-print">
            When opened, the visit is recorded before redirecting to the Google
            review page.
          </p>
        </section>
      </section>

      <section className="panel dashboard-panel">
        <div className="dashboard-header">
          <PanelTitle
            icon={BarChart3}
            title="Google Review Dashboard"
            caption="Unique review link and basic request statistics."
          />
          <button
            type="button"
            className="secondary"
            onClick={loadDashboard}
            disabled={busy === "dashboard"}
          >
            {busy === "dashboard" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            Refresh
          </button>
        </div>
        <DashboardStats data={dashboard} preview={linkPreview} />
      </section>

      <section className="layout-grid">
        <form className="panel" onSubmit={generateReviewLink}>
          <PanelTitle
            icon={Send}
            title={recordContext ? "Current Record" : "Generate Review Link"}
            caption={
              recordContext
                ? "The review link is generated automatically for this record."
                : "Use this only when testing or fixing a specific CRM record."
            }
          />

          {recordContext && (
            <div className="context-box">
              <span>Current record</span>
              <strong>
                {recordContext.moduleApiName} / {recordContext.recordId}
              </strong>
            </div>
          )}

          <div className="field-grid">
            <Field label="Module">
              <select
                value={config.generateModule}
                onChange={(event) =>
                  updateConfig("generateModule", event.target.value)
                }
                disabled={Boolean(recordContext)}
              >
                <option value="Leads">Leads</option>
                <option value="Contacts">Contacts</option>
              </select>
            </Field>
            <Field label="Zoho Record ID">
              <input
                value={config.generateRecordId}
                onChange={(event) =>
                  updateConfig("generateRecordId", event.target.value)
                }
                placeholder="Enter Zoho record ID"
                readOnly={Boolean(recordContext)}
                required
              />
            </Field>
          </div>

          <button type="submit" disabled={busy === "generate"}>
            {busy === "generate" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Send size={16} />
            )}
            {recordContext ? "Update Link Again" : "Generate and Save"}
          </button>

          {generatedLink && (
            <ResultBox
              label="Generated link"
              value={generatedLink}
              action={<CopyButton value={generatedLink} />}
            />
          )}
        </form>

        <section className="panel">
          <PanelTitle
            icon={Search}
            title="Follow-ups"
            caption="Find generated links that have not been opened."
          />

          <div className="follow-row">
            <Field label="Days Since Link Generated">
              <input
                value={config.followUpDays}
                onChange={(event) =>
                  updateConfig("followUpDays", event.target.value)
                }
                type="number"
                min="0"
              />
            </Field>
            <button
              type="button"
              onClick={loadFollowUps}
              disabled={busy === "followups"}
            >
              {busy === "followups" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Search size={16} />
              )}
              Load
            </button>
            <button
              type="button"
              className="secondary"
              onClick={createFollowUpTasks}
              disabled={busy === "createFollowups"}
            >
              {busy === "createFollowups" ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              Create Tasks
            </button>
          </div>

          <FollowUpList data={followUps} />
        </section>
      </section>
    </main>
  );
}

async function updateZohoReviewLink(moduleApiName, recordId, reviewLink) {
  if (!window.ZOHO?.CRM?.API?.updateRecord) {
    throw new Error(
      "Zoho record update API is unavailable. Open this widget from inside a Lead or Contact record.",
    );
  }

  const response = await window.ZOHO.CRM.API.updateRecord({
    Entity: moduleApiName,
    APIData: {
      id: String(recordId),
      googlereview__Google_Review_Link: reviewLink,
    },
    Trigger: [],
  });

  const result = Array.isArray(response?.data)
    ? response.data[0]
    : response?.data;
  if (result?.status && String(result.status).toLowerCase() !== "success") {
    const detail =
      result?.details?.api_name || result?.message || "unknown Zoho error";
    throw new Error(
      `Zoho could not update the Google Review Link field: ${detail}`,
    );
  }
}

async function createZohoFollowUpTask(record) {
  if (!window.ZOHO?.CRM?.API?.insertRecord) {
    throw new Error(
      "Zoho task creation API is unavailable. Open this widget from inside Zoho CRM.",
    );
  }

  const response = await window.ZOHO.CRM.API.insertRecord({
    Entity: "Tasks",
    APIData: {
      Subject: "Follow up for Google review request",
      Status: "Not Started",
      Priority: "Normal",
      Due_Date: new Date().toISOString().slice(0, 10),
      What_Id: { id: String(record.crm_record_id) },
      $se_module: record.module_api_name,
    },
    Trigger: [],
  });

  const result = Array.isArray(response?.data)
    ? response.data[0]
    : response?.data;
  if (result?.status && String(result.status).toLowerCase() !== "success") {
    const detail =
      result?.details?.api_name || result?.message || "unknown Zoho error";
    throw new Error(`Zoho could not create the follow-up task: ${detail}`);
  }
}

async function getZohoRecordName(moduleApiName, recordId) {
  if (!moduleApiName || !recordId || !window.ZOHO?.CRM?.API?.getRecord)
    return "";
  try {
    const response = await window.ZOHO.CRM.API.getRecord({
      Entity: moduleApiName,
      RecordID: String(recordId),
    });
    const record = Array.isArray(response?.data)
      ? response.data[0]
      : response?.data;
    return buildZohoRecordName(record);
  } catch {
    return "";
  }
}

function buildZohoRecordName(record) {
  if (!record) return "";
  const directName =
    record.Full_Name || record.Name || record.Account_Name?.name || "";
  if (directName) return String(directName).trim();
  return [record.First_Name, record.Last_Name].filter(Boolean).join(" ").trim();
}

function DashboardStats({ data, preview }) {
  const [activityFilter, setActivityFilter] = useState("All");
  const stats = data?.totals || {};
  const reviewLinkFormat = data?.review_link_format || preview;
  const recentLinks = data?.recent_links || [];
  const filteredRecentLinks =
    activityFilter === "All"
      ? recentLinks
      : recentLinks.filter(
          (record) => record.module_api_name === activityFilter,
        );
  const moduleOptions = ["All", "Leads", "Contacts"];
  const metrics = [
    {
      label: "Generated links",
      value: stats.generated_links ?? 0,
      tone: "blue",
    },
    { label: "Opened links", value: stats.opened_links ?? 0, tone: "green" },
    {
      label: "Unopened links",
      value: stats.unopened_links ?? 0,
      tone: "amber",
    },
    { label: "Total opens", value: stats.total_opens ?? 0, tone: "purple" },
    {
      label: "Follow-up tasks",
      value: stats.follow_up_tasks ?? 0,
      tone: "sky",
    },
  ];

  return (
    <div className="dashboard-content">
      <section className="dashboard-link">
        <div>
          <span className="eyebrow">Tracking URL pattern</span>
          <strong>Unique review link template</strong>
        </div>
        <div className="dashboard-link-value">
          <code>{reviewLinkFormat}</code>
          <CopyButton value={reviewLinkFormat} />
        </div>
      </section>

      <div className="metric-grid">
        {metrics.map((metric) => (
          <div
            className="metric-card"
            key={metric.label}
            data-tone={metric.tone}
          >
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      <section className="dashboard-section">
        <div className="section-heading">
          <span className="eyebrow">Breakdown</span>
          <h2>Performance by module</h2>
        </div>
        <div className="module-grid">
          {(data?.by_module || []).map((row) => (
            <article className="module-card" key={row.module_api_name}>
              <div className="module-card-title">
                <strong>{row.module_api_name}</strong>
                <span>{row.generated_links} generated</span>
              </div>
              <dl>
                <div>
                  <dt>Generated</dt>
                  <dd>{row.generated_links}</dd>
                </div>
                <div>
                  <dt>Opened</dt>
                  <dd>{row.opened_links}</dd>
                </div>
                <div>
                  <dt>Total opens</dt>
                  <dd>{row.total_opens}</dd>
                </div>
              </dl>
            </article>
          ))}
          {data && (!data.by_module || data.by_module.length === 0) && (
            <p className="empty-state">
              No review links have been generated yet.
            </p>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest activity</span>
            <h2>Recent review links</h2>
          </div>
          <div
            className="activity-filter"
            aria-label="Filter latest activity by module"
          >
            {moduleOptions.map((moduleName) => (
              <button
                className={activityFilter === moduleName ? "active" : ""}
                key={moduleName}
                onClick={() => setActivityFilter(moduleName)}
                type="button"
              >
                {moduleName === "All" ? "All" : moduleName}
              </button>
            ))}
          </div>
        </div>
        <RecentLinks records={data ? filteredRecentLinks : undefined} />
      </section>
    </div>
  );
}

function RecentLinks({ records }) {
  const [recordNames, setRecordNames] = useState({});

  useEffect(() => {
    let cancelled = false;
    const missing = (records || []).filter(
      (record) => !record.crm_record_name && !recordNames[recordKey(record)],
    );
    if (missing.length === 0) return;

    Promise.all(
      missing.map(async (record) => {
        const name = await getZohoRecordName(
          record.module_api_name,
          record.crm_record_id,
        );
        return [recordKey(record), name];
      }),
    ).then((entries) => {
      if (cancelled) return;
      const nextNames = Object.fromEntries(entries.filter(([, name]) => name));
      if (Object.keys(nextNames).length > 0) {
        setRecordNames((current) => ({ ...current, ...nextNames }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [records]);

  if (!records) {
    return (
      <p className="empty-state">
        Refresh the dashboard to see recent review links.
      </p>
    );
  }
  if (records.length === 0) {
    return <p className="empty-state">No recent review links yet.</p>;
  }
  return (
    <div className="recent-list">
      {records.map((record) => (
        <article className="recent-item" key={recordKey(record)}>
          <div className="recent-record">
            <span>{record.module_api_name}</span>
            <strong>
              {record.crm_record_name ||
                recordNames[recordKey(record)] ||
                record.crm_record_id}
            </strong>
            {(record.crm_record_name || recordNames[recordKey(record)]) && (
              <small className="record-id">{record.crm_record_id}</small>
            )}
            {record.last_generated_at && (
              <small>
                Generated {formatDateTime(record.last_generated_at)}
              </small>
            )}
          </div>
          <div className="recent-open-count">
            <strong>{record.open_count || 0}</strong>
            <span>opens</span>
          </div>
          <div className="recent-link-cell">
            <code>{record.review_link}</code>
            <CopyButton value={record.review_link} />
          </div>
        </article>
      ))}
    </div>
  );
}

function recordKey(record) {
  return `${record.module_api_name}:${record.crm_record_id}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PanelTitle({ icon: Icon, title, caption }) {
  return (
    <div className="panel-title">
      <Icon size={18} />
      <div>
        <h2>{title}</h2>
        <p>{caption}</p>
      </div>
    </div>
  );
}

function Field({ label, children, span }) {
  return (
    <label className={span ? "span-field" : ""}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function StatusMessage({ type, text }) {
  const Icon = type === "error" ? TriangleAlert : CheckCircle2;
  return (
    <div className={`message ${type}`}>
      <Icon size={16} />
      {text}
    </div>
  );
}

function ResultBox({ label, value, action }) {
  return (
    <div className="result-box">
      <span>{label}</span>
      <code>{value}</code>
      {action}
    </div>
  );
}

function FollowUpList({ data }) {
  if (!data) {
    return (
      <p className="empty-state">
        Load follow-ups to see generated links that have not been opened.
      </p>
    );
  }
  if (data.records.length === 0) {
    return <p className="empty-state">No unopened review links found.</p>;
  }
  return (
    <div className="follow-list">
      {data.records.map((record) => (
        <article
          className="follow-item"
          key={`${record.module_api_name}:${record.crm_record_id}`}
        >
          <div>
            <strong>
              {record.module_api_name} / {record.crm_record_id}
            </strong>
            <span>
              Generated{" "}
              {formatDate(record.last_generated_at || record.created_at)}
            </span>
            <code>{record.review_link}</code>
          </div>
          <CopyButton value={record.review_link} />
        </article>
      ))}
    </div>
  );
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button type="button" className="secondary compact" onClick={copy}>
      <Clipboard size={14} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

async function apiRequest(config, path, options = {}) {
  const backendUrl = normalizeBaseUrl(config.backendUrl);
  if (!backendUrl) throw new Error("Backend URL is required.");
  if (!config.crmOrgId?.trim())
    throw new Error(
      "Zoho organisation ID was not detected from Zoho. Reopen this widget inside Zoho CRM.",
    );
  if (!config.apiKey?.trim())
    throw new Error(
      "Server connection key was not found. Check the extension setup.",
    );

  const response = await fetch(`${backendUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      "x-crm-org-id": config.crmOrgId.trim(),
      "x-api-key": config.apiKey.trim(),
      "bypass-tunnel-reminder": "true",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatErrorMessage(body.error, response.status));
  }
  return body;
}

function formatErrorMessage(errorCode, status) {
  if (errorCode && errorMessages[errorCode]) {
    return errorMessages[errorCode];
  }
  if (errorCode) {
    return String(errorCode).replaceAll("_", " ");
  }
  return `Request failed. Please try again. (${status})`;
}

function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
}

function normalizeZohoContext(data) {
  const moduleApiName = data?.Entity;
  const rawEntityId = Array.isArray(data?.EntityId)
    ? data.EntityId[0]
    : data?.EntityId;
  const recordId = String(rawEntityId || "").trim();

  if (!isSupportedModule(moduleApiName) || !recordId) {
    return null;
  }

  return { moduleApiName, recordId };
}

async function hydrateZohoOrgId() {
  try {
    const orgInfo = await window.ZOHO?.CRM?.CONFIG?.getOrgInfo?.();
    const crmOrgId = extractZohoOrgId(orgInfo);
    if (!crmOrgId) return;

    window.dispatchEvent(
      new CustomEvent("google-review-org-detected", { detail: crmOrgId }),
    );
  } catch (error) {
    console.warn("Unable to detect Zoho org ID", error);
  }
}

async function hydrateBackendAccessKey() {
  const value = await getZohoVariable(backendAccessKey);
  if (value) {
    window.dispatchEvent(
      new CustomEvent("google-review-api-key-detected", { detail: value }),
    );
  }
}

async function hydrateReviewOpenSyncUrl() {
  const value = await getZohoVariable(reviewOpenSyncUrl);
  if (value) {
    window.dispatchEvent(
      new CustomEvent("google-review-open-sync-url-detected", {
        detail: value,
      }),
    );
  }
}

async function getZohoVariable(variableName) {
  try {
    const response =
      await window.ZOHO?.CRM?.API?.getOrgVariable?.(variableName);
    return extractZohoVariableValue(response);
  } catch {
    return "";
  }
}

function extractZohoVariableValue(data) {
  const candidates = [
    data?.Success?.Content,
    data?.Content,
    data?.value,
    data?.Value,
    data?.data?.[0]?.value,
    data?.variables?.[0]?.value,
  ];
  const value = candidates.find((candidate) => String(candidate || "").trim());
  return String(value || "").trim();
}

function extractZohoOrgId(data) {
  const candidates = [
    data?.org?.[0]?.zgid,
    data?.org?.[0]?.id,
    data?.org?.[0]?.primary_zuid,
    data?.org?.[0]?.org_id,
    data?.org?.[0]?.OrgId,
    data?.users?.[0]?.zgid,
    data?.Success?.Content,
    data?.Content,
    data?.zgid,
    data?.primary_zuid,
    data?.org_id,
    data?.OrgId,
  ];
  const value = candidates.find((candidate) => String(candidate || "").trim());
  return String(value || "").trim();
}

function isSupportedModule(value) {
  return value === "Leads" || value === "Contacts";
}

function loadLocalConfig() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("google-review-settings") || "{}",
    );
    delete saved.crmOrgId;
    delete saved.apiKey;
    delete saved.reviewOpenSyncUrl;
    return enforceProductionBackend({
      ...defaults,
      ...saved,
      crmOrgId: "",
    });
  } catch {
    return defaults;
  }
}

function enforceProductionBackend(config) {
  return { ...config, backendUrl: productionBackendUrl, generateRecordId: "" };
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "unknown";
  return date.toLocaleString();
}

createRoot(document.getElementById("root")).render(<App />);
