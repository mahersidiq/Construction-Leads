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
    // Paginate to get ALL leads (Supabase default limit is 1000)
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
    const headers = ["property_address","owner_name","owner_mail_address","phone","email","year_built","appraised_value","lead_score","permit_flag","permit_status","out_of_state_owner","status","notes","acct_number"];
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
