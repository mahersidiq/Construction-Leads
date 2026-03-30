import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { ScoreBadge } from "./StatusBadge";

const STATUSES = ["new", "contacted", "follow_up", "won", "lost"];

const COLUMNS = [
  { key: "property_address", label: "Address" },
  { key: "owner_name", label: "Owner" },
  { key: "owner_mail_address", label: "Mail Address" },
  { key: "year_built", label: "Year Built" },
  { key: "appraised_value", label: "Value" },
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

export default function LeadTable({ leads, onUpdate, sortCol, sortAsc, onSort }) {
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesValue, setNotesValue] = useState("");

  const handleStatusChange = async (id, newStatus) => {
    if (!supabaseConfigured) return;
    await supabase.from("leads").update({ status: newStatus }).eq("id", id);
    onUpdate();
  };

  const startEditNotes = (lead) => {
    setEditingNotes(lead.id);
    setNotesValue(lead.notes || "");
  };

  const saveNotes = async (id) => {
    if (!supabaseConfigured) return;
    await supabase.from("leads").update({ notes: notesValue }).eq("id", id);
    setEditingNotes(null);
    onUpdate();
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

  if (leads.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        No leads match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                onClick={() => onSort(col.key)}
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
              >
                {col.label}
                <SortArrow col={col.key} sortCol={sortCol} sortAsc={sortAsc} />
              </th>
            ))}
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Notes
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {leads.map((lead) => (
            <tr key={lead.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-sm text-gray-900 max-w-xs truncate" title={lead.property_address}>
                {lead.property_address}
              </td>
              <td className="px-4 py-3 text-sm text-gray-600 max-w-[200px] truncate" title={lead.owner_name}>
                {lead.owner_name}
              </td>
              <td className="px-4 py-3 text-sm text-gray-500 max-w-[200px] truncate" title={lead.owner_mail_address}>
                {lead.owner_mail_address || <span className="text-gray-300">--</span>}
              </td>
              <td className="px-4 py-3 text-sm text-gray-600">
                {lead.year_built}
              </td>
              <td className="px-4 py-3 text-sm text-gray-600">
                {formatCurrency(lead.appraised_value)}
              </td>
              <td className="px-4 py-3">
                <ScoreBadge score={lead.lead_score} />
              </td>
              <td className="px-4 py-3 text-sm">
                {lead.permit_flag ? (
                  <span className="text-orange-600 font-medium">
                    {lead.permit_status || "Yes"}
                  </span>
                ) : (
                  <span className="text-gray-400">--</span>
                )}
              </td>
              <td className="px-4 py-3">
                <select
                  value={lead.status || "new"}
                  onChange={(e) => handleStatusChange(lead.id, e.target.value)}
                  className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3 text-sm max-w-xs">
                {editingNotes === lead.id ? (
                  <textarea
                    value={notesValue}
                    onChange={(e) => setNotesValue(e.target.value)}
                    onKeyDown={(e) => handleNotesKeyDown(e, lead.id)}
                    onBlur={() => saveNotes(lead.id)}
                    className="w-full text-sm border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    rows={2}
                    autoFocus
                  />
                ) : (
                  <div
                    onClick={() => startEditNotes(lead)}
                    className="cursor-pointer text-gray-600 hover:text-gray-900 min-h-[1.5rem] truncate"
                    title="Click to edit"
                  >
                    {lead.notes || (
                      <span className="text-gray-300 italic">Add notes...</span>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
