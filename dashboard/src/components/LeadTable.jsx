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

function googleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function hcadUrl(acct) {
  if (!acct) return null;
  return `https://public.hcad.org/records/details.asp?cession=a&searchval=${encodeURIComponent(acct)}`;
}

function txSosUrl(name) {
  if (!name) return null;
  return `https://mycpa.cpa.state.tx.us/coa/coaSearchBtn?search_term=${encodeURIComponent(name)}&search_type=ALL`;
}

function OwnerLookup({ lead }) {
  const [open, setOpen] = useState(false);
  const name = lead.owner_name || "";
  const addr = lead.property_address || "";
  const acct = lead.acct_number || "";
  const isLLC = /\b(LLC|LP|LTD|INC|CORP|TRUST|PARTNERS)\b/i.test(name);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 font-medium whitespace-nowrap"
      >
        Lookup
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-20 bg-white rounded-lg shadow-lg border border-gray-200 p-3 w-56">
            <p className="text-xs font-medium text-gray-500 mb-2 uppercase">Research Links</p>
            <div className="space-y-1.5">
              <a
                href={googleSearchUrl(`"${name}" Houston TX`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded px-2 py-1"
              >
                <span>🔍</span> Google Owner
              </a>
              <a
                href={googleSearchUrl(`"${name}" phone email contact`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded px-2 py-1"
              >
                <span>📞</span> Find Contact Info
              </a>
              {isLLC && (
                <a
                  href={txSosUrl(name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded px-2 py-1"
                >
                  <span>🏛️</span> TX Secretary of State
                </a>
              )}
              {acct && (
                <a
                  href={hcadUrl(acct)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded px-2 py-1"
                >
                  <span>🏢</span> HCAD Property Record
                </a>
              )}
              <a
                href={googleSearchUrl(`${addr} apartments`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded px-2 py-1"
              >
                <span>📍</span> Google Maps / Property
              </a>
              <a
                href={googleSearchUrl(`"${name}" site:linkedin.com`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded px-2 py-1"
              >
                <span>💼</span> LinkedIn
              </a>
            </div>
            <hr className="my-2" />
            <p className="text-[10px] text-gray-400">
              For bulk phone/email, use a skip tracing service like BatchSkipTracing or PropStream
            </p>
          </div>
        </>
      )}
    </div>
  );
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
              Lookup
            </th>
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
                <OwnerLookup lead={lead} />
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
