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
  { value: "hotel", label: "Hotel" },
  { value: "commercial", label: "Commercial" },
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
  { key: "owner_name", label: "Owner" },
  { key: "owner_mail_address", label: "Mail Address" },
  { key: "year_built", label: "Year" },
  { key: "appraised_value", label: "Value" },
  { key: "property_type", label: "Type" },
  { key: "lead_score", label: "Score" },
  { key: "permit_flag", label: "Permit" },
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
  const colors = type === "hotel"
    ? "bg-amber-100 text-amber-800"
    : "bg-indigo-100 text-indigo-800";
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
// HCAD + Permit API Data Fetch Pipeline (runs entirely in the browser)
// ---------------------------------------------------------------------------

const HCAD_CKAN_URL = "https://data.houstontx.gov/api/3/action/datastore_search";
const HCAD_RESOURCE_ID = "84a171f2-d601-4c79-bc4d-9733b378c663";
const PERMIT_RESOURCE_ID = "80b03984-0e31-41ff-937b-35b686755bf9";
const CKAN_PAGE_SIZE = 32000;

const HOTEL_KEYWORDS = ["HOTEL", "MOTEL", "INN", "LODGE", "SUITES", "EXTENDED STAY", "HOSPITALITY"];

const COMMERCIAL_PERMIT_PATTERNS = [
  [/TENANT\s*IMPROVEMENT/i, "Tenant Improvement"],
  [/\bTI\b/i, "Tenant Improvement"],
  [/CHANGE\s*OF\s*OCCUPANCY/i, "Change of Occupancy"],
  [/CHANGE\s*OF\s*USE/i, "Change of Use"],
  [/CERTIFICATE\s*OF\s*OCCUPANCY/i, "Certificate of Occupancy"],
  [/CODE\s*VIOLATION/i, "Code Violation"],
  [/FAILED\s*INSPECTION/i, "Failed Inspection"],
  [/STOP\s*WORK\s*ORDER/i, "Stop Work Order"],
];

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

function matchesHotel(text) {
  if (!text) return false;
  const upper = String(text).toUpperCase();
  return HOTEL_KEYWORDS.some((kw) => upper.includes(kw));
}

function classifyPermit(text) {
  if (!text) return null;
  const str = String(text);
  for (const [pattern, label] of COMMERCIAL_PERMIT_PATTERNS) {
    if (pattern.test(str)) return label;
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

function scoreCommercialLead(lead) {
  let s = 0;
  if (lead.permit_flag) s += 20;
  if (lead.out_of_state_owner) s += 20;
  if (lead.year_built && lead.year_built < 1985) s += 15;
  if (lead.appraised_value && lead.appraised_value > 2000000) s += 15;
  if (lead.property_type === "hotel") s += 15;
  if (lead.permit_status === "Stop Work Order" || lead.permit_status === "Failed Inspection") s += 15;
  return Math.min(s, 100);
}

async function fetchCkanPages(resourceId, onProgress, extraParams = {}) {
  const all = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      resource_id: resourceId,
      limit: String(CKAN_PAGE_SIZE),
      offset: String(offset),
      ...extraParams,
    });
    const resp = await fetch(`${HCAD_CKAN_URL}?${params}`);
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
      // --- Step 1: Fetch HCAD property data ---
      setStatus("Fetching HCAD property data from Houston Open Data...");
      addLog("Querying HCAD CKAN API...");

      const hcadRaw = await fetchCkanPages(
        HCAD_RESOURCE_ID,
        (count) => {
          setStatus(`Fetching HCAD data: ${count.toLocaleString()} records...`);
          setProgress(5 + Math.min(25, Math.round(count / 5000)));
        },
      );
      addLog(`Fetched ${hcadRaw.length.toLocaleString()} total HCAD records`);
      setProgress(30);

      if (hcadRaw.length === 0) {
        setStatus("Error: No data returned from HCAD API.");
        setRunning(false);
        return;
      }

      // Discover columns from first record
      const sample = hcadRaw[0];
      const acctCol = findCol(sample, ["ACCT", "acct", "Account", "account", "acct_number"]);
      const classCol = findCol(sample, ["STATE_CLASS", "state_class", "State_Class", "state_cd", "class_cd"]);
      const yrCol = findCol(sample, ["YR_IMPR", "yr_impr", "yr_built", "Year_Built", "year_built"]);
      const valCol = findCol(sample, ["TOT_APPR_VAL", "tot_appr_val", "Appraised_Value", "appraised_value", "Tot_Appr_Val"]);
      const addrCol = findCol(sample, ["SITE_ADDR_1", "site_addr_1", "Site_Addr_1", "property_address", "address"]);
      const addr2Col = findCol(sample, ["SITE_ADDR_2", "site_addr_2", "Site_Addr_2"]);
      const addr3Col = findCol(sample, ["SITE_ADDR_3", "site_addr_3", "Site_Addr_3"]);
      const nameCol = findCol(sample, ["OWNER", "owner", "Owner", "owner_name", "NAME", "name"]);
      const mailCol = findCol(sample, ["MAIL_ADDR_1", "mail_addr_1", "Mail_Addr_1", "mail_addr", "owner_mail_address"]);
      const mailStateCol = findCol(sample, ["MAIL_STATE", "mail_state", "Mail_State", "mail_st"]);
      const descCol = findCol(sample, ["DESCRIPTION", "description", "Description", "IMPR_DESC", "impr_desc", "BLD_NAME", "bld_name"]);

      addLog(`Columns found — acct: ${acctCol || "?"}, class: ${classCol || "?"}, year: ${yrCol || "?"}, value: ${valCol || "?"}, addr: ${addrCol || "?"}, owner: ${nameCol || "?"}, desc: ${descCol || "?"}`);

      // --- Step 2: Filter for F1 commercial + hotel keywords ---
      setStatus("Filtering for F1 commercial properties with hotel keywords...");

      const filtered = [];
      for (const rec of hcadRaw) {
        // F1 filter
        if (classCol) {
          const cls = String(rec[classCol] || "").trim().toUpperCase();
          if (cls !== "F1") continue;
        }

        // Hotel keyword filter across description/name columns
        const descText = [descCol, nameCol].filter(Boolean).map((c) => rec[c]).join(" ");
        if (!matchesHotel(descText)) continue;

        // Year filter: 1970-2010
        const yr = parseInt(rec[yrCol]) || 0;
        if (yrCol && (yr < 1970 || yr > 2010)) continue;

        // Build address
        const addrParts = [addrCol, addr2Col, addr3Col]
          .filter(Boolean)
          .map((c) => String(rec[c] || "").trim())
          .filter(Boolean);
        const propertyAddress = addrParts.join(" ").replace(/\s+/g, " ").trim();

        const mailState = mailStateCol ? String(rec[mailStateCol] || "").trim().toUpperCase() : "";
        const outOfState = mailState !== "" && mailState !== "TX";

        filtered.push({
          acct_number: String(rec[acctCol] || "").trim(),
          property_address: propertyAddress,
          owner_name: nameCol ? String(rec[nameCol] || "").trim() : "",
          owner_mail_address: mailCol ? String(rec[mailCol] || "").trim() : "",
          year_built: yr || null,
          appraised_value: valCol ? parseFloat(rec[valCol]) || null : null,
          property_type: matchesHotel(descText) ? "hotel" : "commercial",
          out_of_state_owner: outOfState,
          permit_flag: false,
          permit_type: null,
          permit_status: null,
          permit_date: null,
          _addr_norm: normalizeAddr(propertyAddress),
        });
      }

      addLog(`F1 + hotel keyword filter: ${filtered.length} properties`);
      setProgress(40);

      if (filtered.length === 0) {
        setStatus("No F1 commercial/hotel properties found. This dataset may not be HCAD property data — see the log below and check the browser console for the full sample record.");
        const allKeys = Object.keys(sample);
        addLog(`ALL columns (${allKeys.length}): ${allKeys.join(", ")}`);
        addLog(`First record (JSON): ${JSON.stringify(sample).slice(0, 800)}...`);
        console.log("Full sample record:", sample);
        console.log("All columns:", allKeys);
        setRunning(false);
        return;
      }

      // --- Step 3: Fetch permits ---
      setStatus("Fetching permit data from Houston Open Data...");
      addLog("Querying Houston Permits CKAN API...");

      const permitRaw = await fetchCkanPages(
        PERMIT_RESOURCE_ID,
        (count) => {
          setStatus(`Fetching permits: ${count.toLocaleString()} records...`);
          setProgress(40 + Math.min(20, Math.round(count / 5000)));
        },
      );
      addLog(`Fetched ${permitRaw.length.toLocaleString()} total permit records`);
      setProgress(60);

      // --- Step 4: Filter permits for commercial types ---
      setStatus("Filtering for commercial permit types...");
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);

      const permitMap = new Map();
      if (permitRaw.length > 0) {
        const pSample = permitRaw[0];
        const pAddrCol = findCol(pSample, ["Address", "address", "project_address", "street_address"]);
        const pTypeCol = findCol(pSample, ["Permit Type", "permit_type", "Type", "type"]);
        const pDescCol = findCol(pSample, ["Description", "description", "Project Description", "permit_description"]);
        const pDateCol = findCol(pSample, ["Issue Date", "issue_date", "Issued Date", "permit_date", "Date Issued"]);

        for (const rec of permitRaw) {
          const typeText = [pTypeCol, pDescCol].filter(Boolean).map((c) => rec[c]).join(" ");
          const category = classifyPermit(typeText);
          if (!category) continue;

          // Recency filter
          if (pDateCol) {
            const d = new Date(rec[pDateCol]);
            if (!isNaN(d) && d < cutoff) continue;
          }

          const addr = pAddrCol ? normalizeAddr(rec[pAddrCol]) : "";
          if (!addr) continue;

          const existing = permitMap.get(addr);
          const severity = ["Stop Work Order", "Failed Inspection", "Code Violation", "Change of Occupancy", "Change of Use", "Tenant Improvement", "Certificate of Occupancy"].indexOf(category);
          if (!existing || severity < existing.severity) {
            permitMap.set(addr, {
              category,
              severity,
              date: pDateCol ? rec[pDateCol] : null,
            });
          }
        }
      }
      addLog(`Commercial permits (last 12 months): ${permitMap.size} unique addresses`);
      setProgress(70);

      // --- Step 5: Join permits to properties and score ---
      setStatus("Scoring leads...");
      let matchCount = 0;
      for (const lead of filtered) {
        const permit = permitMap.get(lead._addr_norm);
        if (permit) {
          lead.permit_flag = true;
          lead.permit_type = permit.category;
          lead.permit_status = permit.category;
          lead.permit_date = permit.date ? new Date(permit.date).toISOString().slice(0, 10) : null;
          matchCount++;
        }
        lead.lead_score = scoreCommercialLead(lead);
        delete lead._addr_norm;
      }

      addLog(`Permit matches: ${matchCount} leads with active permits`);
      filtered.sort((a, b) => b.lead_score - a.lead_score);
      setProgress(75);

      // --- Step 6: Upsert to Supabase ---
      setStatus(`Uploading ${filtered.length} scored leads to Supabase...`);
      const batchSize = 500;
      let uploaded = 0;
      for (let i = 0; i < filtered.length; i += batchSize) {
        const batch = filtered.slice(i, i + batchSize);
        const { error } = await supabase
          .from("commercial_leads")
          .upsert(batch, { onConflict: "acct_number" });
        if (error) {
          setStatus(`Error at row ${i}: ${error.message}`);
          setRunning(false);
          return;
        }
        uploaded += batch.length;
        setProgress(75 + Math.round((uploaded / filtered.length) * 25));
        setStatus(`Uploaded ${uploaded}/${filtered.length}...`);
      }

      const topLead = filtered[0];
      addLog(`Top lead: ${topLead?.property_address} (score ${topLead?.lead_score})`);
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
          <span className="text-xs text-gray-500 ml-2">Pull live data from Houston Open Data APIs</span>
        </div>
        <span className="text-gray-400">{open ? "\u25B2" : "\u25BC"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          <p className="text-xs text-gray-500">
            Pulls HCAD property data + Houston permit data directly from the city's CKAN API.
            Filters for F1 commercial properties with hotel/hospitality keywords (built 1970-2010),
            matches permits (TI, code violations, stop work orders from the last 12 months),
            scores 0-100, and uploads to Supabase.
          </p>

          <button
            onClick={runPipeline}
            disabled={running}
            className="bg-blue-600 text-white py-2 px-5 rounded-md hover:bg-blue-700 transition-colors font-medium text-sm disabled:opacity-50"
          >
            {running ? "Processing..." : "Fetch from HCAD & Score"}
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
            <div className="bg-gray-50 rounded-md p-2 max-h-40 overflow-y-auto">
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
    const headers = ["property_address","owner_name","owner_mail_address","year_built","appraised_value","property_type","lead_score","permit_flag","permit_type","permit_status","out_of_state_owner","status","notes","acct_number"];
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
            <p className="text-xs text-gray-500">Hotels &middot; Tenant Improvements &middot; Code Violations</p>
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
                      <td className="px-3 py-2 text-sm text-gray-600 max-w-[180px] truncate" title={lead.owner_name}>
                        {lead.owner_name}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 max-w-[180px] truncate" title={lead.owner_mail_address}>
                        {lead.owner_mail_address || <span className="text-gray-300">--</span>}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600">{lead.year_built}</td>
                      <td className="px-3 py-2 text-sm text-gray-600">{formatCurrency(lead.appraised_value)}</td>
                      <td className="px-3 py-2"><PropertyTypeBadge type={lead.property_type} /></td>
                      <td className="px-3 py-2"><ScoreBadge score={lead.lead_score} /></td>
                      <td className="px-3 py-2 text-sm">
                        {lead.permit_flag ? (
                          <span className="text-orange-600 font-medium text-xs">{lead.permit_status || "Yes"}</span>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
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
