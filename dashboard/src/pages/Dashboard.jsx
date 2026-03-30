import { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import SummaryBar from "../components/SummaryBar";
import FilterBar from "../components/FilterBar";
import LeadTable from "../components/LeadTable";

const DEFAULT_FILTERS = {
  status: "",
  minScore: "",
  permitOnly: false,
  outOfStateOnly: false,
};

export default function Dashboard({ onLogout }) {
  const [allLeads, setAllLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .order("lead_score", { ascending: false });

    if (error) {
      console.error("Error fetching leads:", error);
    } else {
      setAllLeads(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const filteredLeads = allLeads.filter((lead) => {
    if (filters.status && lead.status !== filters.status) return false;
    if (filters.minScore && lead.lead_score < Number(filters.minScore))
      return false;
    if (filters.permitOnly && !lead.permit_flag) return false;
    if (filters.outOfStateOnly && !lead.out_of_state_owner) return false;
    return true;
  });

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
          <button
            onClick={onLogout}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <SummaryBar leads={allLeads} />

        <div className="bg-white rounded-lg shadow border border-gray-200 p-4">
          <FilterBar filters={filters} onChange={setFilters} />
        </div>

        <div className="bg-white rounded-lg shadow border border-gray-200">
          {loading ? (
            <div className="text-center py-12 text-gray-500">
              Loading leads...
            </div>
          ) : (
            <LeadTable leads={filteredLeads} onUpdate={fetchLeads} />
          )}
        </div>
      </main>
    </div>
  );
}
