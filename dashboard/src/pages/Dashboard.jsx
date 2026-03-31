import { useEffect, useState, useCallback } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import SummaryBar from "../components/SummaryBar";
import FilterBar from "../components/FilterBar";
import LeadTable from "../components/LeadTable";

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

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";

function PhoneEnrichPanel({ onDone }) {
  const envKey = import.meta.env.VITE_GOOGLE_PLACES_KEY || "";
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("google_places_key") || envKey);
  const [batchSize, setBatchSize] = useState(25);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);

  const leadsWithoutPhone = onDone ? 0 : 0; // placeholder

  const saveKey = (key) => {
    setApiKey(key);
    localStorage.setItem("google_places_key", key);
  };

  const runEnrichment = async () => {
    if (!apiKey) {
      setProgress("Please enter your Google Places API key first.");
      return;
    }
    setRunning(true);
    setProgress("Starting phone number lookup...");
    setResults(null);

    try {
      const functionUrl = `${SUPABASE_URL}/functions/v1/enrich-phones`;
      const resp = await fetch(functionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, batchSize }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setProgress(`Error: ${data.error || resp.statusText}`);
        setRunning(false);
        return;
      }

      setResults(data);
      setProgress(data.message);
      if (data.enriched > 0 && onDone) onDone();
    } catch (err) {
      setProgress(`Error: ${err.message}`);
    }
    setRunning(false);
  };

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex justify-between items-center text-left hover:bg-gray-50"
      >
        <div>
          <span className="font-medium text-gray-900">Auto-Find Phone Numbers</span>
          <span className="text-xs text-gray-500 ml-2">Uses Google Places API to find leasing office phones</span>
        </div>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Google Places API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => saveKey(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full max-w-md focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="AIza..."
            />
            <p className="text-xs text-gray-400 mt-1">
              Stored locally in your browser. Never sent to our servers.
            </p>
          </div>

          <div className="flex items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Batch Size
              </label>
              <select
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value={10}>10 leads</option>
                <option value={25}>25 leads</option>
                <option value={50}>50 leads</option>
                <option value={100}>100 leads</option>
                <option value={200}>200 leads</option>
              </select>
            </div>
            <button
              onClick={runEnrichment}
              disabled={running || !apiKey}
              className="bg-purple-600 text-white py-2 px-4 rounded-md hover:bg-purple-700 transition-colors font-medium text-sm disabled:opacity-50"
            >
              {running ? "Searching..." : "Find Phone Numbers"}
            </button>
          </div>

          {progress && (
            <p className={`text-sm ${progress.startsWith("Error") ? "text-red-600" : "text-gray-600"}`}>
              {progress}
            </p>
          )}

          {results?.results && (
            <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-gray-500">Address</th>
                    <th className="px-3 py-1.5 text-left text-gray-500">Business</th>
                    <th className="px-3 py-1.5 text-left text-gray-500">Phone</th>
                    <th className="px-3 py-1.5 text-left text-gray-500">Website</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {results.results.map((r, i) => (
                    <tr key={i} className={r.phone ? "bg-green-50" : ""}>
                      <td className="px-3 py-1.5 max-w-[200px] truncate">{r.address}</td>
                      <td className="px-3 py-1.5 max-w-[150px] truncate">{r.businessName || "--"}</td>
                      <td className="px-3 py-1.5 text-blue-600">{r.phone || "--"}</td>
                      <td className="px-3 py-1.5 max-w-[150px] truncate">
                        {r.website ? <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{r.website}</a> : "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-gray-400">
            Searches Google Places for each lead's address, finds the apartment leasing office phone and website.
            Processes leads with highest scores first. Only fills in leads that don't already have a phone number.
            Cost: ~$0.017 per lookup ($200/month free credit from Google).
          </p>
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ onLogout, onUpload }) {
  const [allLeads, setAllLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sortCol, setSortCol] = useState("lead_score");
  const [sortAsc, setSortAsc] = useState(false);

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
        .from("leads")
        .select("*")
        .order("lead_score", { ascending: false })
        .range(from, from + pageSize - 1);
      if (fetchError) {
        console.error("Error fetching leads:", fetchError);
        setError("Failed to load leads. Check your Supabase configuration.");
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
      if (filters.minScore && lead.lead_score < Number(filters.minScore))
        return false;
      if (filters.yearFrom && lead.year_built < Number(filters.yearFrom))
        return false;
      if (filters.yearTo && lead.year_built > Number(filters.yearTo))
        return false;
      if (filters.minValue && (lead.appraised_value || 0) < Number(filters.minValue))
        return false;
      if (filters.maxValue && (lead.appraised_value || 0) > Number(filters.maxValue))
        return false;
      if (filters.addressSearch) {
        const search = filters.addressSearch.toUpperCase();
        if (!(lead.property_address || "").toUpperCase().includes(search))
          return false;
      }
      if (filters.ownerSearch) {
        const search = filters.ownerSearch.toUpperCase();
        if (!(lead.owner_name || "").toUpperCase().includes(search))
          return false;
      }
      if (filters.zipCode) {
        if (!(lead.property_address || "").includes(filters.zipCode))
          return false;
      }
      if (filters.propertyType && lead.state_class !== filters.propertyType)
        return false;
      if (filters.permitOnly && !lead.permit_flag) return false;
      if (filters.outOfStateOnly && !lead.out_of_state_owner) return false;
      return true;
    })
    .sort((a, b) => {
      const aVal = a[sortCol] ?? "";
      const bVal = b[sortCol] ?? "";
      const aStr = String(aVal);
      const bStr = String(bVal);
      let cmp;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else if (typeof aVal === "boolean" || typeof bVal === "boolean") {
        cmp = Number(aVal) - Number(bVal);
      } else {
        cmp = aStr.localeCompare(bStr);
      }
      return sortAsc ? cmp : -cmp;
    });

  const exportCsv = () => {
    const headers = ["property_address","owner_name","owner_mail_address","phone","email","year_built","appraised_value","unit_count","lead_score","permit_flag","permit_status","out_of_state_owner","status","notes","acct_number"];
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
    a.download = `construction-leads-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const phonesFound = allLeads.filter((l) => l.phone).length;
  const phonesNeeded = allLeads.filter((l) => !l.phone && l.property_address).length;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Construction Leads
            </h1>
            <p className="text-xs text-gray-500">Saadi Construction Group</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-400">
              {allLeads.length} total &middot; {filteredLeads.length} shown
              {phonesFound > 0 && ` · ${phonesFound} phones`}
            </span>
            <button
              onClick={exportCsv}
              className="text-sm text-green-600 hover:text-green-800 transition-colors font-medium"
            >
              Export CSV
            </button>
            {onUpload && (
              <button
                onClick={onUpload}
                className="text-sm text-blue-600 hover:text-blue-800 transition-colors font-medium"
              >
                Upload Data
              </button>
            )}
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
        <SummaryBar leads={allLeads} />

        <PhoneEnrichPanel onDone={fetchLeads} />

        <div className="bg-white rounded-lg shadow border border-gray-200 p-4">
          <FilterBar filters={filters} onChange={setFilters} />
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200">
          {error ? (
            <div className="text-center py-12 text-red-600 text-sm">
              {error}
            </div>
          ) : loading ? (
            <div className="text-center py-12 text-gray-500">
              Loading leads...
            </div>
          ) : (
            <LeadTable
              leads={filteredLeads}
              onUpdate={fetchLeads}
              sortCol={sortCol}
              sortAsc={sortAsc}
              onSort={handleSort}
            />
          )}
        </div>
      </main>
    </div>
  );
}
