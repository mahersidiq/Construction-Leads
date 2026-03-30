import { ScoreBadge } from "./StatusBadge";

export default function LeadCard({ lead }) {
  return (
    <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
      <div className="flex justify-between items-start mb-2">
        <h3 className="text-sm font-semibold text-gray-900 truncate flex-1 mr-2">
          {lead.property_address}
        </h3>
        <ScoreBadge score={lead.lead_score} />
      </div>
      <p className="text-sm text-gray-600">{lead.owner_name}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
        {lead.year_built && <span>Built {lead.year_built}</span>}
        {lead.unit_count && <span>{lead.unit_count} units</span>}
        {lead.permit_flag && (
          <span className="text-orange-600 font-medium">Permit</span>
        )}
        {lead.out_of_state_owner && (
          <span className="text-blue-600 font-medium">Out-of-state</span>
        )}
      </div>
    </div>
  );
}
