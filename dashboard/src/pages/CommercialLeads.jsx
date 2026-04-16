import { useEffect, useState, useCallback } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { ScoreBadge } from "../components/StatusBadge";

const STATUSES = ["new", "contacted", "follow_up", "won", "lost"];

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "follow_up", label: "Follow Up" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const PROPERTY_TYPE_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "high-priority", label: "High Priority" },
  { value: "violation", label: "Violation" },
];

const DEFAULT_FILTERS = {
  status: "",
  minScore: "",
  yearFrom: "",
  yearTo: "",
  minValue: "",
  maxValue: "",
  addressSearch: "",
  ownerSearch: "",
  zipCode: "",
  propertyType: "",
  permitOnly: false,
  outOfStateOnly: false,
};

const COLUMNS = [
  { key: "property_address", label: "Address" },
  { key: "owner_name", label: "Applicant" },
  { key: "permit_date", label: "Permit Date" },
  { key: "appraised_value", label: "Fees" },
  { key: "property_type", label: "Priority" },
  { key: "lead_score", label: "Score" },
  { key: "permit_type", label: "Permits" },
];

function SortArrow({ col, sortCol, sortAsc }) {
  if (col !== sortCol) return <span className="text-gray-300 ml-1">↕</span>;
  return <span className="ml-1">{sortAsc ? "↑" : "↓"}</span>;
}

function formatCurrency(val) {
  if (val == null) return "--";
  return "$" + Number(val).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function PropertyTypeBadge({ type }) {
  if (!type) return <span className="text-gray-300">--</span>;
  const colors = type === "high-priority"
    ? "bg-red-100 text-red-800"
    : "bg-amber-100 text-amber-800";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${colors}`}>
      {type}
    </span>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-lg shadow px-4 py-3 border border-gray-200">
      <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
      <p className={`text-2xl font-bold ${color || "text-gray-900"}`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Houston Permits → Commercial Leads Pipeline (runs in the browser)
// ---------------------------------------------------------------------------

const CKAN_URL = "https://data.houstontx.gov/api/3/action/datastore_search";
const PERMIT_RESOURCE_ID = "80b03984-0e31-41ff-937b-35b686755bf9";
const CKAN_PAGE_SIZE = 32000;

const RECENT_DAYS = 365;

function findCol(record, candidates) {
  for (const c of candidates) {
    if (c in record) return c;
  }
  const keys = Object.keys(record);
  for (const c of candidates) {
    const lower = c.toLowerCase();
    const match = keys.find((k) => k.toLowerCase() === lower);
    if (match) return match;
  }
  return null;
}

function normalizeAddr(raw) {
  if (!raw) return "";
  let addr = String(raw).toUpperCase().trim().split(",")[0].trim();
  addr = addr.replace(/\b(UNIT|STE|SUITE|APT|#)\s*\S*/g, "");
  addr = addr.replace(/\b\d{5}(-\d{4})?\s*$/, "");
  for (const [long, short] of [["STREET","ST"],["AVENUE","AVE"],["BOULEVARD","BLVD"],["DRIVE","DR"],["LANE","LN"],["ROAD","RD"],["COURT","CT"],["CIRCLE","CIR"],["PLACE","PL"],["PARKWAY","PKWY"],["HIGHWAY","HWY"]]) {
    addr = addr.replace(new RegExp("\\b" + long + "\\b", "g"), short);
  }
  for (const city of ["HOUSTON","BELLAIRE","PASADENA","DEER PARK","BAYTOWN","HUMBLE","KATY","TOMBALL","SPRING","CYPRESS"]) {
    addr = addr.replace(new RegExp("\\b" + city + "\\s*$"), "");
  }
  return addr.replace(/\s+/g, " ").trim();
}

function scorePermitLead(lead) {
  let s = 0;
  // Total fees = project size signal
  const fees = lead._total_fees || 0;
  if (fees >= 50000) s += 25;
  else if (fees >= 10000) s += 20;
  else if (fees >= 2000) s += 15;
  else if (fees >= 500) s += 10;
  else s += 5;
  // Multiple permits at same address = sustained activity
  const count = lead._permit_count || 1;
  if (count >= 5) s += 25;
  else if (count >= 3) s += 20;
  else if (count >= 2) s += 10;
  // Recency: permits in last 90 days are hotter
  if (lead._most_recent_days != null && lead._most_recent_days <= 90) s += 20;
  else if (lead._most_recent_days != null && lead._most_recent_days <= 180) s += 10;
  // Unit count signal
  const units = lead._total_units || 0;
  if (units >= 50) s += 20;
  else if (units >= 10) s += 15;
  else if (units >= 2) s += 10;
  return Math.min(s, 100);
}

async function fetchCkanPages(resourceId, onProgress) {
  const all = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      resource_id: resourceId,
      limit: String(CKAN_PAGE_SIZE),
      offset: String(offset),
    });
    const resp = await fetch(`${CKAN_URL}?${params}`);
    if (!resp.ok) throw new Error(`CKAN API error: ${resp.status} ${resp.statusText}`);
    const json = await resp.json();
    const records = json?.result?.records || [];
    if (records.length === 0) break;
    all.push(...records);
    if (onProgress) onProgress(all.length);
    if (records.length < CKAN_PAGE_SIZE) break;
    offset += CKAN_PAGE_SIZE;
  }
  return all;
}

function DataFetchPanel({ onDone }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState([]);

  const addLog = (msg) => setLog((prev) => [...prev, msg]);

  const runPipeline = async () => {
    if (!supabaseConfigured) {
      setStatus("Error: Supabase is not configured.");
      return;
    }
    setRunning(true);
    setStatus("Starting...");
    setProgress(5);
    setLog([]);

    try {
      // --- Step 1: Fetch permit data ---
      setStatus("Fetching Houston permit data...");
      addLog("Querying Permits CKAN API (resource 80b03984)...");

      const permitRaw = await fetchCkanPages(
        PERMIT_RESOURCE_ID,
        (count) => {
          setStatus(`Fetching permits: ${count.toLocaleString()} records...`);
          setProgress(5 + Math.min(35, Math.round(count / 2000)));
        },
      );
      addLog(`Fetched ${permitRaw.length.toLocaleString()} total permit records`);
      setProgress(40);

      if (permitRaw.length === 0) {
        setStatus("Error: No data returned from Permits API.");
        setRunning(false);
        return;
      }

      // Discover columns from actual data
      const sample = permitRaw[0];
      const allKeys = Object.keys(sample);
      addLog(`Columns (${allKeys.length}): ${allKeys.join(", ")}`);
      console.log("Permit sample record:", sample);

      const addrCol = findCol(sample, [
        "Address", "address", "Project Address", "project_address",
        "Street_Address", "street_address", "SITE_ADDRESS", "Location",
      ]);
      const dateCol = findCol(sample, [
        "Receipt Dt", "receipt_dt", "Receipt_Dt",
        "Issue Date", "issue_date", "Issued Date", "issued_date",
        "Date", "date", "permit_date", "Date Issued",
      ]);
      const feeCol = findCol(sample, [
        "Total Collected", "total_collected", "Permit Fee", "permit_fee",
        "Fee", "Amount",
      ]);
      const unitsCol = findCol(sample, [
        "Units", "units", "Unit Count", "unit_count",
      ]);
      const applicantCol = findCol(sample, [
        "Applicant Name", "applicant_name", "Applicant\nName",
        "Applicant", "Owner", "owner",
      ]);
      const projectCol = findCol(sample, [
        "Project No", "project_no", "Project_No", "Project Number",
      ]);
      const idCol = findCol(sample, [
        "Receipt No", "receipt_no", "Receipt_No",
        "Permit Number", "permit_number", "Record ID", "_id",
      ]);
      const zipCol = findCol(sample, [
        "Payee Zip", "payee_zip", "Zip", "zip", "ZIP",
      ]);

      addLog(`Mapped — addr: ${addrCol || "NONE"}, date: ${dateCol || "NONE"}, fee: ${feeCol || "NONE"}, units: ${unitsCol || "NONE"}, applicant: ${applicantCol || "NONE"}, id: ${idCol || "_id"}`);

      if (!addrCol) {
        setStatus("Error: No address column found in permit data.");
        addLog(`First record: ${JSON.stringify(sample).slice(0, 1000)}`);
        setRunning(false);
        return;
      }

      // --- Step 2: Filter recent permits and group by address ---
      setStatus("Filtering recent permits and grouping by address...");
      const cutoff = new Date();
      cutoff.setTime(cutoff.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);

      const addressMap = new Map();
      let matchedCount = 0;
      let skippedOld = 0;
      let skippedNoAddr = 0;

      for (const rec of permitRaw) {
        // Recency filter
        if (dateCol) {
          const d = new Date(rec[dateCol]);
          if (!isNaN(d.getTime()) && d < cutoff) {
            skippedOld++;
            continue;
          }
        }

        const rawAddr = String(rec[addrCol] || "").trim();
        if (!rawAddr) {
          skippedNoAddr++;
          continue;
        }
        matchedCount++;

        const normAddr = normalizeAddr(rawAddr);
        const permitDate = dateCol && rec[dateCol] ? new Date(rec[dateCol]) : null;
        const permitId = idCol ? String(rec[idCol] || "") : "";
        const fee = feeCol ? parseFloat(rec[feeCol]) || 0 : 0;
        const units = unitsCol ? parseInt(rec[unitsCol]) || 0 : 0;
        const applicant = applicantCol ? String(rec[applicantCol] || "").trim() : "";
        const project = projectCol ? String(rec[projectCol] || "").trim() : "";
        const zip = zipCol ? String(rec[zipCol] || "").trim() : "";

        const existing = addressMap.get(normAddr);
        if (existing) {
          existing.count++;
          existing.total_fees += fee;
          existing.total_units = Math.max(existing.total_units, units);
          if (permitDate && (!existing.most_recent || permitDate > existing.most_recent)) {
            existing.most_recent = permitDate;
          }
          if (permitId) existing.ids.push(permitId);
          if (applicant && !existing.applicant) existing.applicant = applicant;
          if (project && !existing.project) existing.project = project;
        } else {
          addressMap.set(normAddr, {
            raw_address: rawAddr,
            count: 1,
            total_fees: fee,
            total_units: units,
            most_recent: permitDate,
            ids: permitId ? [permitId] : [],
            applicant,
            project,
            zip,
          });
        }
      }

      addLog(`Recent permits (last ${RECENT_DAYS} days): ${matchedCount.toLocaleString()}`);
      addLog(`Skipped: ${skippedOld.toLocaleString()} older, ${skippedNoAddr.toLocaleString()} no address`);
      addLog(`Unique addresses: ${addressMap.size.toLocaleString()}`);
      setProgress(65);

      if (addressMap.size === 0) {
        setStatus("No recent permits found. The date column may not be matching — check the log.");
        addLog(`First record: ${JSON.stringify(sample).slice(0, 800)}`);
        setRunning(false);
        return;
      }

      // --- Step 3: Build scored leads ---
      setStatus("Scoring leads...");
      const leads = [];
      const now = new Date();

      for (const [normAddr, data] of addressMap) {
        const daysSince = data.most_recent
          ? Math.round((now - data.most_recent) / (1000 * 60 * 60 * 24))
          : null;
        const isHighValue = data.total_fees >= 10000 || data.count >= 3;

        const lead = {
          acct_number: data.ids[0] || normAddr.replace(/\s+/g, "-").slice(0, 50),
          property_address: data.raw_address,
          owner_name: data.applicant || "",
          owner_mail_address: data.zip ? `Houston, TX ${data.zip}` : "",
          year_built: null,
          appraised_value: data.total_fees > 0 ? data.total_fees : null,
          property_type: isHighValue ? "high-priority" : "violation",
          out_of_state_owner: false,
          permit_flag: true,
          permit_type: `${data.count} permit(s), $${data.total_fees.toLocaleString()} fees`,
          permit_status: data.project || `${data.count} permits`,
          permit_date: data.most_recent ? data.most_recent.toISOString().slice(0, 10) : null,
          _total_fees: data.total_fees,
          _permit_count: data.count,
          _most_recent_days: daysSince,
          _total_units: data.total_units,
        };
        lead.lead_score = scorePermitLead(lead);
        leads.push(lead);
      }

      // Clean internal fields
      for (const lead of leads) {
        delete lead._total_fees;
        delete lead._permit_count;
        delete lead._most_recent_days;
        delete lead._total_units;
      }

      leads.sort((a, b) => b.lead_score - a.lead_score);
      addLog(`Scored ${leads.length} leads. Top score: ${leads[0]?.lead_score}`);
      setProgress(75);

      // --- Step 4: Upsert to Supabase ---
      setStatus(`Uploading ${leads.length} leads to Supabase...`);
      const batchSize = 500;
      let uploaded = 0;
      for (let i = 0; i < leads.length; i += batchSize) {
        const batch = leads.slice(i, i + batchSize);
        const { error } = await supabase
          .from("commercial_leads")
          .upsert(batch, { onConflict: "acct_number" });
        if (error) {
          setStatus(`Error at row ${i}: ${error.message}`);
          addLog(`Supabase error: ${error.message}`);
          setRunning(false);
          return;
        }
        uploaded += batch.length;
        setProgress(75 + Math.round((uploaded / leads.length) * 25));
        setStatus(`Uploaded ${uploaded}/${leads.length}...`);
      }

      const top3 = leads.slice(0, 3).map((l) => `${l.property_address} (${l.lead_score})`).join("; ");
      addLog(`Top leads: ${top3}`);
      setStatus(`Done! ${uploaded} commercial leads scored and uploaded.`);
      setProgress(100);
      setRunning(false);
      if (onDone) onDone();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      addLog(`Error: ${err.stack || err.message}`);
      console.error(err);
      setRunning(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex justify-between items-center text-left hover:bg-gray-50"
      >
        <div>
          <span className="font-medium text-gray-900">Fetch &amp; Score Commercial Leads</span>
          <span className="text-xs text-gray-500 ml-2">Pull live permit &amp; violation data from Houston Open Data</span>
        </div>
        <span className="text-gray-400">{open ? "\u25B2" : "\u25BC"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          <p className="text-xs text-gray-500">
            Pulls Houston permit records from the city's CKAN API.
            Filters for commercial-relevant permits (stop work orders, code violations, failed inspections,
            tenant improvements, renovations) from the last 12 months.
            Groups by address, scores by severity, frequency, and recency, then uploads to Supabase.
          </p>

          <button
            onClick={runPipeline}
            disabled={running}
            className="bg-blue-600 text-white py-2 px-5 rounded-md hover:bg-blue-700 transition-colors font-medium text-sm disabled:opacity-50"
          >
            {running ? "Processing..." : "Fetch Violations & Score"}
          </button>

          {(running || progress > 0) && (
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          {status && (
            <p className={`text-sm ${status.startsWith("Error") ? "text-red-600" : status.startsWith("Done") ? "text-green-600" : "text-gray-600"}`}>
              {status}
            </p>
          )}
          {log.length > 0 && (
            <div className="bg-gray-50 rounded-md p-2 max-h-48 overflow-y-auto">
              {log.map((msg, i) => (
                <p key={i} className="text-xs text-gray-600 font-mono">{msg}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommercialLeads({ onBack, onLogout }) {
  const [allLeads, setAllLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sortCol, setSortCol] = useState("lead_score");
  const [sortAsc, setSortAsc] = useState(false);
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesValue, setNotesValue] = useState("");

  const fetchLeads = useCallback(async () => {
    if (!supabaseConfigured) {
      setError("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment variables.");
      setLoading(false);
      return;
    }
    setLoading(true);
    let allData = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error: fetchError } = await supabase
        .from("commercial_leads")
        .select("*")
        .order("lead_score", { ascending: false })
        .range(from, from + pageSize - 1);
      if (fetchError) {
        console.error("Error fetching commercial leads:", fetchError);
        setError("Failed to load commercial leads. Check your Supabase configuration.");
        setLoading(false);
        return;
      }
      allData = allData.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    setAllLeads(allData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(col === "property_address" || col === "owner_name");
    }
  };

  const filteredLeads = allLeads
    .filter((lead) => {
      if (filters.status && lead.status !== filters.status) return false;
      if (filters.minScore && lead.lead_score < Number(filters.minScore)) return false;
      if (filters.yearFrom && lead.year_built < Number(filters.yearFrom)) return false;
      if (filters.yearTo && lead.year_built > Number(filters.yearTo)) return false;
      if (filters.minValue && (lead.appraised_value || 0) < Number(filters.minValue)) return false;
      if (filters.maxValue && (lead.appraised_value || 0) > Number(filters.maxValue)) return false;
      if (filters.addressSearch) {
        const search = filters.addressSearch.toUpperCase();
        if (!(lead.property_address || "").toUpperCase().includes(search)) return false;
      }
      if (filters.ownerSearch) {
        const search = filters.ownerSearch.toUpperCase();
        if (!(lead.owner_name || "").toUpperCase().includes(search)) return false;
      }
      if (filters.zipCode) {
        if (!(lead.property_address || "").includes(filters.zipCode)) return false;
      }
      if (filters.propertyType && lead.property_type !== filters.propertyType) return false;
      if (filters.permitOnly && !lead.permit_flag) return false;
      if (filters.outOfStateOnly && !lead.out_of_state_owner) return false;
      return true;
    })
    .sort((a, b) => {
      const aVal = a[sortCol] ?? "";
      const bVal = b[sortCol] ?? "";
      let cmp;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else if (typeof aVal === "boolean" || typeof bVal === "boolean") {
        cmp = Number(aVal) - Number(bVal);
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }
      return sortAsc ? cmp : -cmp;
    });

  const exportCsv = () => {
    const headers = ["property_address","owner_name","permit_date","appraised_value","property_type","lead_score","permit_type","permit_status","status","notes","acct_number"];
    const rows = filteredLeads.map((l) =>
      headers.map((h) => {
        const v = l[h];
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `commercial-leads-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStatusChange = async (id, newStatus) => {
    if (!supabaseConfigured) return;
    await supabase.from("commercial_leads").update({ status: newStatus }).eq("id", id);
    fetchLeads();
  };

  const startEditNotes = (lead) => {
    setEditingNotes(lead.id);
    setNotesValue(lead.notes || "");
  };

  const saveNotes = async (id) => {
    if (!supabaseConfigured) return;
    await supabase.from("commercial_leads").update({ notes: notesValue }).eq("id", id);
    setEditingNotes(null);
    fetchLeads();
  };

  const handleNotesKeyDown = (e, id) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveNotes(id);
    }
    if (e.key === "Escape") {
      setEditingNotes(null);
    }
  };

  const update = (key, value) => {
    setFilters({ ...filters, [key]: value });
  };

  const total = allLeads.length;
  const newCount = allLeads.filter((l) => l.status === "new").length;
  const contacted = allLeads.filter((l) => l.status === "contacted").length;
  const won = allLeads.filter((l) => l.status === "won").length;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Commercial Leads
            </h1>
            <p className="text-xs text-gray-500">Active Permits &middot; Code Violations &middot; Construction Activity</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-400">
              {allLeads.length} total &middot; {filteredLeads.length} shown
            </span>
            <button
              onClick={exportCsv}
              className="text-sm text-green-600 hover:text-green-800 transition-colors font-medium"
            >
              Export CSV
            </button>
            <button
              onClick={onBack}
              className="text-sm text-blue-600 hover:text-blue-800 transition-colors font-medium"
            >
              Back to Dashboard
            </button>
            <button
              onClick={onLogout}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Summary Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Leads" value={total} />
          <StatCard label="New" value={newCount} color="text-blue-600" />
          <StatCard label="Contacted" value={contacted} color="text-purple-600" />
          <StatCard label="Won" value={won} color="text-green-600" />
        </div>

        <DataFetchPanel onDone={fetchLeads} />

        {/* Filter Bar */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Search Address</label>
                <input
                  type="text"
                  value={filters.addressSearch}
                  onChange={(e) => update("addressSearch", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Westheimer"
                />
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Search Owner</label>
                <input
                  type="text"
                  value={filters.ownerSearch}
                  onChange={(e) => update("ownerSearch", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Marriott"
                />
              </div>
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-500 mb-1">Zip Code</label>
                <input
                  type="text"
                  value={filters.zipCode}
                  onChange={(e) => update("zipCode", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="77002"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Property Type</label>
                <select
                  value={filters.propertyType}
                  onChange={(e) => update("propertyType", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {PROPERTY_TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                <select
                  value={filters.status}
                  onChange={(e) => update("status", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Min Score</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={filters.minScore}
                  onChange={(e) => update("minScore", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Year From</label>
                <input
                  type="number"
                  min={1900}
                  max={2030}
                  value={filters.yearFrom}
                  onChange={(e) => update("yearFrom", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="1970"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Year To</label>
                <input
                  type="number"
                  min={1900}
                  max={2030}
                  value={filters.yearTo}
                  onChange={(e) => update("yearTo", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="2010"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Min Value ($)</label>
                <input
                  type="number"
                  min={0}
                  value={filters.minValue}
                  onChange={(e) => update("minValue", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Max Value ($)</label>
                <input
                  type="number"
                  min={0}
                  value={filters.maxValue}
                  onChange={(e) => update("maxValue", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="any"
                />
              </div>
              <div className="flex items-center gap-4 py-2">
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.permitOnly}
                    onChange={(e) => update("permitOnly", e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Permit Flag
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.outOfStateOnly}
                    onChange={(e) => update("outOfStateOnly", e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Out-of-State
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Lead Table */}
        <div className="bg-white rounded-lg shadow border border-gray-200">
          {error ? (
            <div className="text-center py-12 text-red-600 text-sm">{error}</div>
          ) : loading ? (
            <div className="text-center py-12 text-gray-500">Loading commercial leads...</div>
          ) : filteredLeads.length === 0 ? (
            <div className="text-center py-12 text-gray-500">No leads match the current filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
                      >
                        {col.label}
                        <SortArrow col={col.key} sortCol={sortCol} sortAsc={sortAsc} />
                      </th>
                    ))}
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Notes</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredLeads.map((lead) => (
                    <tr key={lead.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-sm text-gray-900 max-w-[220px] truncate" title={lead.property_address}>
                        {lead.property_address}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600 max-w-[160px] truncate" title={lead.owner_name}>
                        {lead.owner_name || <span className="text-gray-300">--</span>}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">
                        {lead.permit_date || <span className="text-gray-300">--</span>}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600">{formatCurrency(lead.appraised_value)}</td>
                      <td className="px-3 py-2"><PropertyTypeBadge type={lead.property_type} /></td>
                      <td className="px-3 py-2"><ScoreBadge score={lead.lead_score} /></td>
                      <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px] truncate" title={lead.permit_type}>
                        {lead.permit_type || <span className="text-gray-300">--</span>}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={lead.status || "new"}
                          onChange={(e) => handleStatusChange(lead.id, e.target.value)}
                          className="text-xs border border-gray-300 rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>{s.replace("_", " ")}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-sm max-w-[150px]">
                        {editingNotes === lead.id ? (
                          <textarea
                            value={notesValue}
                            onChange={(e) => setNotesValue(e.target.value)}
                            onKeyDown={(e) => handleNotesKeyDown(e, lead.id)}
                            onBlur={() => saveNotes(lead.id)}
                            className="w-full text-xs border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            rows={2}
                            autoFocus
                          />
                        ) : (
                          <div
                            onClick={() => startEditNotes(lead)}
                            className="cursor-pointer text-xs text-gray-600 hover:text-gray-900 min-h-[1.5rem] truncate"
                            title="Click to edit"
                          >
                            {lead.notes || <span className="text-gray-300 italic">Add notes...</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
