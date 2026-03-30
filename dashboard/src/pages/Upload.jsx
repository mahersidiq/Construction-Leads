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

async function streamParseFile(file, onProgress) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let headers = null;
  const rows = [];
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
        continue;
      }

      rows.push(trimmed.split("\t").map((v) => v.trim()));
    }

    if (onProgress) {
      onProgress(bytesRead, file.size, rows.length, headers);
    }
  }

  if (buffer.trim() && headers) {
    rows.push(buffer.trim().split("\t").map((v) => v.trim()));
  }

  return { headers, rows };
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
    setStatus(
      `Reading real_acct file (${(acctFile.size / 1024 / 1024).toFixed(0)} MB)...`,
    );

    try {
      // Stream-parse real_acct
      const acctData = await streamParseFile(acctFile, (bytes, total, rowCount, headers) => {
        const pct = Math.round((bytes / total) * 50);
        setProgress(pct);
        if (rowCount % 100000 === 0 && rowCount > 0) {
          setStatus(`Reading real_acct: ${rowCount} rows (${Math.round((bytes / total) * 100)}%)...`);
        }
      });

      if (!acctData.headers || acctData.rows.length === 0) {
        setDebug(
          `Headers found: ${acctData.headers ? acctData.headers.join(", ") : "none"}. Rows: ${acctData.rows.length}`,
        );
        setStatus("Error: No data found in real_acct file.");
        setProcessing(false);
        return;
      }

      const h = acctData.headers;
      setDebug(`Columns: ${h.join(", ")}`);

      const acctIdx = findColIndex(h, ["acct", "account", "acct_number"]);
      const classIdx = findColIndex(h, ["state_class", "state_cd", "class_cd", "impr_state_cd"]);
      const yrIdx = findColIndex(h, ["yr_built", "year_built", "yr_impr"]);
      const addrIdx = findColIndex(h, ["site_addr", "property_address", "address", "situs"]);
      const valIdx = findColIndex(h, ["tot_appr_val", "appraised_value", "total_appraised_value", "appr_val"]);

      const realAcctIdx = acctIdx !== -1 ? acctIdx : 0;

      setStatus(
        `Loaded ${acctData.rows.length} records. Filtering multifamily + year 1980-2005...`,
      );

      // Filter in one pass
      const filtered = [];
      for (const row of acctData.rows) {
        if (classIdx !== -1) {
          const cls = (row[classIdx] || "").toUpperCase();
          if (!MULTIFAMILY_CODES.has(cls)) continue;
        }
        if (yrIdx !== -1) {
          const yr = parseInt(row[yrIdx]);
          if (isNaN(yr) || yr < 1980 || yr > 2005) continue;
        }
        filtered.push(row);
      }

      setStatus(
        `Found ${filtered.length} matching properties. Reading owners file...`,
      );
      setProgress(55);

      // Stream-parse owners
      const ownersData = await streamParseFile(ownersFile, (bytes, total) => {
        const pct = 55 + Math.round((bytes / total) * 15);
        setProgress(pct);
      });

      const oh = ownersData.headers;
      const ownerAcctIdx = findColIndex(oh, ["acct", "account", "acct_number"]);
      const nameIdx = findColIndex(oh, ["owner_name", "name", "owner"]);
      const mailIdx = findColIndex(oh, ["mail_addr", "mailing_address", "mail_address", "tnt_mail_adr"]);
      const mailStateIdx = findColIndex(oh, ["mail_state", "state", "mail_st"]);

      const realOwnerAcctIdx = ownerAcctIdx !== -1 ? ownerAcctIdx : 0;

      // Build owner lookup
      const ownerMap = {};
      for (const row of ownersData.rows) {
        const key = row[realOwnerAcctIdx];
        if (key && !ownerMap[key]) ownerMap[key] = row;
      }

      setStatus(`Joined ${Object.keys(ownerMap).length} owners. Scoring leads...`);
      setProgress(75);

      // Build and score leads
      const leads = [];
      for (const row of filtered) {
        const acct = row[realAcctIdx] || "";
        const owner = ownerMap[acct] || [];
        const mailAddr = mailIdx !== -1 ? owner[mailIdx] || "" : "";
        const ownerState =
          mailStateIdx !== -1
            ? (owner[mailStateIdx] || "").toUpperCase().trim()
            : extractState(mailAddr);
        const outOfState = ownerState !== "" && ownerState !== "TX";
        const yearBuilt = yrIdx !== -1 ? parseInt(row[yrIdx]) || null : null;
        const appraisedValue = valIdx !== -1 ? parseFloat(row[valIdx]) || null : null;

        const lead = {
          acct_number: acct,
          property_address: addrIdx !== -1 ? row[addrIdx] || "" : "",
          owner_name: nameIdx !== -1 ? owner[nameIdx] || "" : "",
          owner_mail_address: mailAddr,
          year_built: yearBuilt,
          appraised_value: appraisedValue,
          unit_count: null,
          out_of_state_owner: outOfState,
          permit_flag: false,
          lead_score: 0,
        };
        lead.lead_score = scoreLead(lead);
        leads.push(lead);
      }

      setStatus(`Uploading ${leads.length} leads to Supabase...`);

      // Upsert in batches
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
        const pct = 80 + Math.round((uploaded / leads.length) * 20);
        setProgress(pct);
        setStatus(`Uploaded ${uploaded}/${leads.length} leads...`);
      }

      const topLeads = leads
        .sort((a, b) => b.lead_score - a.lead_score)
        .slice(0, 5)
        .map((l) => `${l.property_address} (${l.lead_score})`)
        .join(", ");

      setStatus(`Done! ${uploaded} leads uploaded.`);
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
        Upload the extracted HCAD text files to process and load leads into the
        database. Files are processed in your browser and sent directly to
        Supabase. Large files are streamed to avoid memory issues.
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
