import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";

const MULTIFAMILY_CODES = new Set();
["A", "B", "F"].forEach((prefix) => {
  const end = prefix === "A" ? 9 : 4;
  for (let i = 1; i <= end; i++) {
    MULTIFAMILY_CODES.add(`${prefix}${i}`);
  }
});

function findColIndex(headers, candidates) {
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

function extractState(addr) {
  if (!addr) return "";
  const match = addr.toUpperCase().match(/\b([A-Z]{2})\s+\d{5}/);
  return match ? match[1] : "";
}

function scoreLead(lead) {
  let s = 0;
  if (lead.out_of_state_owner) s += 20;
  if (lead.year_built && lead.year_built < 1990) s += 15;
  if (lead.appraised_value && lead.appraised_value > 1000000) s += 15;
  if (lead.unit_count && lead.unit_count > 20) s += 15;
  return Math.min(s, 100);
}

/**
 * Stream a file line by line, calling onLine for each data row.
 * Only the header row is stored; the caller decides what to keep.
 */
async function streamLines(file, onHeader, onLine, onProgress) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let headers = null;
  let lineCount = 0;
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytesRead += value.length;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (!headers) {
        headers = trimmed.split("\t").map((h) => h.trim().toLowerCase());
        onHeader(headers);
        continue;
      }

      lineCount++;
      const cols = trimmed.split("\t").map((v) => v.trim());
      onLine(cols);
    }

    if (onProgress && lineCount % 50000 === 0) {
      onProgress(bytesRead, file.size, lineCount);
      // Yield to UI thread every 50k lines
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Process remaining buffer
  if (buffer.trim() && headers) {
    const cols = buffer.trim().split("\t").map((v) => v.trim());
    onLine(cols);
  }

  return { headers, lineCount };
}

export default function Upload({ onDone }) {
  const [status, setStatus] = useState("");
  const [debug, setDebug] = useState("");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!supabaseConfigured) {
      setStatus("Error: Supabase is not configured.");
      return;
    }

    const acctFile = e.target.elements.realAcct.files[0];
    const ownersFile = e.target.elements.owners.files[0];

    if (!acctFile || !ownersFile) {
      setStatus("Please select both files.");
      return;
    }

    setProcessing(true);
    setDebug("");
    setProgress(0);

    try {
      // --- Pass 1: Stream real_acct, filter in place, only keep matches ---
      setStatus(
        `Reading real_acct (${(acctFile.size / 1024 / 1024).toFixed(0)} MB) -- filtering as we go...`,
      );

      let acctIdx = -1;
      let classIdx = -1;
      let yrIdx = -1;
      let addrIdx = -1;
      let valIdx = -1;

      // Store only filtered rows as lightweight objects
      const filtered = [];
      const filteredAccts = new Set();

      const acctResult = await streamLines(
        acctFile,
        (headers) => {
          acctIdx = findColIndex(headers, ["acct", "account", "acct_number"]);
          classIdx = findColIndex(headers, ["state_class", "state_cd", "class_cd", "impr_state_cd"]);
          yrIdx = findColIndex(headers, ["yr_built", "year_built", "yr_impr"]);
          addrIdx = findColIndex(headers, ["site_addr", "property_address", "address", "situs"]);
          valIdx = findColIndex(headers, ["tot_appr_val", "appraised_value", "total_appraised_value", "appr_val"]);
          if (acctIdx === -1) acctIdx = 0;
          setDebug(`Columns: ${headers.join(", ")}`);
        },
        (cols) => {
          // Filter immediately -- discard non-matching rows
          if (classIdx !== -1) {
            const cls = (cols[classIdx] || "").toUpperCase();
            if (!MULTIFAMILY_CODES.has(cls)) return;
          }
          if (yrIdx !== -1) {
            const yr = parseInt(cols[yrIdx]);
            if (isNaN(yr) || yr < 1980 || yr > 2005) return;
          }

          const acct = cols[acctIdx] || "";
          filtered.push({
            acct_number: acct,
            property_address: addrIdx !== -1 ? cols[addrIdx] || "" : "",
            year_built: yrIdx !== -1 ? parseInt(cols[yrIdx]) || null : null,
            appraised_value: valIdx !== -1 ? parseFloat(cols[valIdx]) || null : null,
          });
          filteredAccts.add(acct);
        },
        (bytes, total, lines) => {
          const pct = Math.round((bytes / total) * 40);
          setProgress(pct);
          setStatus(
            `Reading real_acct: ${lines.toLocaleString()} rows scanned, ${filtered.length} matches...`,
          );
        },
      );

      if (filtered.length === 0) {
        setStatus(
          `Error: No multifamily properties found (1980-2005). Scanned ${acctResult.lineCount.toLocaleString()} rows.`,
        );
        setProcessing(false);
        return;
      }

      setStatus(
        `Found ${filtered.length} properties. Reading owners (${(ownersFile.size / 1024 / 1024).toFixed(0)} MB)...`,
      );
      setProgress(45);

      // --- Pass 2: Stream owners, only keep those matching filtered accts ---
      let ownerNameIdx = -1;
      let ownerMailIdx = -1;
      let ownerMailStateIdx = -1;
      let ownerAcctIdx = -1;
      const ownerMap = {};

      await streamLines(
        ownersFile,
        (headers) => {
          ownerAcctIdx = findColIndex(headers, ["acct", "account", "acct_number"]);
          ownerNameIdx = findColIndex(headers, ["owner_name", "name", "owner"]);
          ownerMailIdx = findColIndex(headers, ["mail_addr", "mailing_address", "mail_address", "tnt_mail_adr"]);
          ownerMailStateIdx = findColIndex(headers, ["mail_state", "state", "mail_st"]);
          if (ownerAcctIdx === -1) ownerAcctIdx = 0;
        },
        (cols) => {
          const acct = cols[ownerAcctIdx] || "";
          // Only store owners that match our filtered properties
          if (filteredAccts.has(acct) && !ownerMap[acct]) {
            ownerMap[acct] = {
              name: ownerNameIdx !== -1 ? cols[ownerNameIdx] || "" : "",
              mail: ownerMailIdx !== -1 ? cols[ownerMailIdx] || "" : "",
              state: ownerMailStateIdx !== -1 ? (cols[ownerMailStateIdx] || "").toUpperCase().trim() : "",
            };
          }
        },
        (bytes, total, lines) => {
          const pct = 45 + Math.round((bytes / total) * 20);
          setProgress(pct);
          setStatus(
            `Reading owners: ${lines.toLocaleString()} rows, ${Object.keys(ownerMap).length} matched...`,
          );
        },
      );

      setStatus(`Scoring ${filtered.length} leads...`);
      setProgress(70);

      // --- Score leads ---
      const leads = filtered.map((prop) => {
        const owner = ownerMap[prop.acct_number] || {};
        const ownerState = owner.state || extractState(owner.mail || "");
        const outOfState = ownerState !== "" && ownerState !== "TX";

        const lead = {
          acct_number: prop.acct_number,
          property_address: prop.property_address,
          owner_name: owner.name || "",
          owner_mail_address: owner.mail || "",
          year_built: prop.year_built,
          appraised_value: prop.appraised_value,
          unit_count: null,
          out_of_state_owner: outOfState,
          permit_flag: false,
          lead_score: 0,
        };
        lead.lead_score = scoreLead(lead);
        return lead;
      });

      setStatus(`Uploading ${leads.length} leads to Supabase...`);
      setProgress(75);

      // --- Upsert in batches ---
      const batchSize = 500;
      let uploaded = 0;

      for (let i = 0; i < leads.length; i += batchSize) {
        const batch = leads.slice(i, i + batchSize);
        const { error } = await supabase
          .from("leads")
          .upsert(batch, { onConflict: "acct_number" });

        if (error) {
          setStatus(`Error at row ${i}: ${error.message}`);
          setProcessing(false);
          return;
        }
        uploaded += batch.length;
        const pct = 75 + Math.round((uploaded / leads.length) * 25);
        setProgress(pct);
        setStatus(`Uploaded ${uploaded}/${leads.length} leads...`);
      }

      const topLeads = leads
        .sort((a, b) => b.lead_score - a.lead_score)
        .slice(0, 5)
        .map((l) => `${l.property_address} (${l.lead_score})`)
        .join(", ");

      setStatus(`Done! ${uploaded} leads uploaded to Supabase.`);
      setDebug(`Top leads: ${topLeads}`);
      setProgress(100);
      setProcessing(false);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      setDebug(err.stack || "");
      setProcessing(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        Upload HCAD Data
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Upload the extracted HCAD text files. Files are streamed and filtered in
        your browser -- only matching leads are kept in memory.
      </p>

      <form onSubmit={handleUpload} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            real_acct.txt
            <span className="text-gray-400 font-normal">
              {" "}
              (from Real_acct_owner folder)
            </span>
          </label>
          <input
            name="realAcct"
            type="file"
            accept=".txt,.csv"
            disabled={processing}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            owners.txt
            <span className="text-gray-400 font-normal">
              {" "}
              (from Real_acct_owner folder)
            </span>
          </label>
          <input
            name="owners"
            type="file"
            accept=".txt,.csv"
            disabled={processing}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>

        {(processing || progress > 0) && (
          <div className="w-full bg-gray-200 rounded-full h-2.5">
            <div
              className="bg-blue-600 h-2.5 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {status && (
          <p
            className={`text-sm ${status.startsWith("Error") ? "text-red-600" : status.startsWith("Done") ? "text-green-600" : "text-gray-600"}`}
          >
            {status}
          </p>
        )}

        {debug && (
          <p className="text-xs text-gray-400 font-mono break-all">{debug}</p>
        )}

        <button
          type="submit"
          disabled={processing}
          className="bg-blue-600 text-white py-2 px-6 rounded-md hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
        >
          {processing ? "Processing..." : "Upload & Process"}
        </button>
      </form>
    </div>
  );
}
