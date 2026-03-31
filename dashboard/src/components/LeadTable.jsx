import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { ScoreBadge } from "./StatusBadge";

const STATUSES = ["new", "contacted", "follow_up", "won", "lost"];

const COLUMNS = [
  { key: "property_address", label: "Address" },
  { key: "owner_name", label: "Owner" },
  { key: "owner_mail_address", label: "Mail Address" },
  { key: "year_built", label: "Year" },
  { key: "appraised_value", label: "Value" },
  { key: "unit_count", label: "Units" },
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

// TX Comptroller Franchise Tax search - pre-fills with the LLC name
function txComptrollerUrl(name) {
  return `https://comptroller.texas.gov/taxes/franchise/account-status/search/?taxpayerName=${encodeURIComponent(name)}&taxpayerNumber=&sosFileNumber=`;
}

// TX Socrata Open Data - search active franchise tax permit holders
const TX_DATA_URL = "https://data.texas.gov/resource/9cir-efmm.json";

async function lookupTxEntity(name) {
  // Clean LLC/LP/etc suffix variations for better matching
  const cleanName = name
    .replace(/,?\s*(LLC|L\.L\.C\.|LP|L\.P\.|LTD|INC|CORP|TRUST|PARTNERS?|ET\s+AL)\s*$/i, "")
    .trim();

  try {
    const url = `${TX_DATA_URL}?$where=taxpayer_name like '%25${encodeURIComponent(cleanName.toUpperCase())}%25'&$limit=5`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

function OwnerLookup({ lead, onUpdateContact }) {
  const [open, setOpen] = useState(false);
  const [txData, setTxData] = useState(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState("");
  const name = lead.owner_name || "";
  const addr = lead.property_address || "";
  const acct = lead.acct_number || "";
  const isLLC = /\b(LLC|LP|LTD|INC|CORP|TRUST|PARTNERS)\b/i.test(name);

  const handleTxLookup = async () => {
    setTxLoading(true);
    setTxError("");
    const data = await lookupTxEntity(name);
    if (data) {
      setTxData(data);
    } else {
      setTxError("No results found. Try the Comptroller website directly.");
    }
    setTxLoading(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen(!open); if (!open && isLLC && !txData && !txLoading) handleTxLookup(); }}
        className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 font-medium whitespace-nowrap"
      >
        Lookup
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-20 bg-white rounded-lg shadow-lg border border-gray-200 p-3 w-72 max-h-96 overflow-y-auto">
            {/* TX Entity Results */}
            {isLLC && (
              <div className="mb-3">
                <p className="text-xs font-medium text-gray-500 mb-1 uppercase">TX Entity Lookup</p>
                {txLoading && <p className="text-xs text-gray-400">Searching...</p>}
                {txError && <p className="text-xs text-red-500">{txError}</p>}
                {txData && txData.map((entity, i) => (
                  <div key={i} className="bg-gray-50 rounded p-2 mb-1 text-xs">
                    <p className="font-medium text-gray-800">{entity.taxpayer_name}</p>
                    {entity.taxpayer_address && (
                      <p className="text-gray-600">{entity.taxpayer_address}</p>
                    )}
                    {entity.taxpayer_city && (
                      <p className="text-gray-600">
                        {entity.taxpayer_city}, {entity.taxpayer_state} {entity.taxpayer_zip}
                      </p>
                    )}
                    {entity.taxpayer_number && (
                      <p className="text-gray-400 mt-1">ID: {entity.taxpayer_number}</p>
                    )}
                    {entity.sos_charter_date && (
                      <p className="text-gray-400">Filed: {entity.sos_charter_date}</p>
                    )}
                  </div>
                ))}
                <a
                  href={txComptrollerUrl(name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:text-blue-800 underline"
                >
                  Full search on TX Comptroller →
                </a>
              </div>
            )}

            <p className="text-xs font-medium text-gray-500 mb-1 uppercase">Quick Links</p>
            <div className="space-y-1">
              <a
                href={googleSearchUrl(`"${name}" Houston TX phone email`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-blue-600 hover:bg-blue-50 rounded px-2 py-1"
              >
                Google Contact Info
              </a>
              {acct && (
                <a
                  href={hcadUrl(acct)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs text-blue-600 hover:bg-blue-50 rounded px-2 py-1"
                >
                  HCAD Property Record
                </a>
              )}
              <a
                href={googleSearchUrl(`"${name}" site:linkedin.com`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-blue-600 hover:bg-blue-50 rounded px-2 py-1"
              >
                LinkedIn
              </a>
              <a
                href={googleSearchUrl(`${addr}`)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-blue-600 hover:bg-blue-50 rounded px-2 py-1"
              >
                Google Property
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EditableCell({ value, leadId, field, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || "");

  const save = async () => {
    if (!supabaseConfigured) return;
    await supabase.from("leads").update({ [field]: val }).eq("id", leadId);
    setEditing(false);
    onUpdate();
  };

  if (editing) {
    return (
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
        className="w-full text-xs border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
        autoFocus
        placeholder={field === "phone" ? "555-123-4567" : "https://example.com"}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      className="cursor-pointer text-xs min-h-[1.5rem] truncate"
      title="Click to edit"
    >
      {value ? (
        field === "phone" ? (
          <a href={`tel:${value}`} onClick={(e) => e.stopPropagation()} className="text-blue-600 hover:underline">{value}</a>
        ) : (
          <a href={value.startsWith("http") ? value : `https://${value}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-blue-600 hover:underline truncate">{value}</a>
        )
      ) : (
        <span className="text-gray-300 italic">+ add</span>
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
                className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
              >
                {col.label}
                <SortArrow col={col.key} sortCol={sortCol} sortAsc={sortAsc} />
              </th>
            ))}
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phone</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Website</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lookup</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Notes</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {leads.map((lead) => (
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
              <td className="px-3 py-2 text-sm text-gray-600">{lead.unit_count || <span className="text-gray-300">--</span>}</td>
              <td className="px-3 py-2"><ScoreBadge score={lead.lead_score} /></td>
              <td className="px-3 py-2 text-sm">
                {lead.permit_flag ? (
                  <span className="text-orange-600 font-medium text-xs">{lead.permit_status || "Yes"}</span>
                ) : (
                  <span className="text-gray-400">--</span>
                )}
              </td>
              <td className="px-3 py-2 w-28">
                <EditableCell value={lead.phone} leadId={lead.id} field="phone" onUpdate={onUpdate} />
              </td>
              <td className="px-3 py-2 w-36">
                <EditableCell value={lead.email} leadId={lead.id} field="email" onUpdate={onUpdate} />
              </td>
              <td className="px-3 py-2">
                <OwnerLookup lead={lead} onUpdateContact={onUpdate} />
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
  );
}
