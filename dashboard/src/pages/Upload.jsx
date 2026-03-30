import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";

const MULTIFAMILY_CODES = new Set();
["A", "B", "F"].forEach((prefix) => {
  const end = prefix === "A" ? 9 : 4;
  for (let i = 1; i <= end; i++) {
    MULTIFAMILY_CODES.add(`${prefix}${i}`);
  }
});

function parseTab(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const vals = line.split("\t");
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (vals[i] || "").trim();
    });
    return row;
  });
}

function findCol(row, candidates) {
  for (const c of candidates) {
    if (c in row) return c;
  }
  return null;
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

export default function Upload({ onDone }) {
  const [status, setStatus] = useState("");
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
    setStatus("Reading real_acct file...");

    try {
      const acctText = await acctFile.text();
      const acctRows = parseTab(acctText);
      setStatus(`Loaded ${acctRows.length} property records. Filtering...`);

      if (acctRows.length === 0) {
        setStatus("Error: No data found in real_acct file.");
        setProcessing(false);
        return;
      }

      const sample = acctRows[0];
      const acctCol = findCol(sample, ["acct", "account", "acct_number"]) || Object.keys(sample)[0];
      const classCol = findCol(sample, ["state_class", "state_cd", "class_cd", "impr_state_cd"]);
      const yrCol = findCol(sample, ["yr_built", "year_built", "yr_impr"]);
      const addrCol = findCol(sample, ["site_addr", "property_address", "address", "situs"]);
      const valCol = findCol(sample, ["tot_appr_val", "appraised_value", "total_appraised_value", "appr_val"]);

      let filtered = acctRows;

      if (classCol) {
        filtered = filtered.filter((r) =>
          MULTIFAMILY_CODES.has((r[classCol] || "").toUpperCase()),
        );
        setStatus(`Multifamily properties: ${filtered.length}. Filtering by year...`);
      }

      if (yrCol) {
        filtered = filtered.filter((r) => {
          const yr = parseInt(r[yrCol]);
          return yr >= 1980 && yr <= 2005;
        });
        setStatus(`After year filter: ${filtered.length}. Loading owners...`);
      }

      const ownersText = await ownersFile.text();
      const ownerRows = parseTab(ownersText);
      setStatus(`Loaded ${ownerRows.length} owner records. Joining...`);

      const ownerSample = ownerRows[0] || {};
      const ownerAcctCol = findCol(ownerSample, ["acct", "account", "acct_number"]) || Object.keys(ownerSample)[0];
      const nameCol = findCol(ownerSample, ["owner_name", "name", "owner"]);
      const mailCol = findCol(ownerSample, ["mail_addr", "mailing_address", "mail_address", "tnt_mail_adr"]);
      const mailStateCol = findCol(ownerSample, ["mail_state", "state", "mail_st"]);

      const ownerMap = {};
      ownerRows.forEach((r) => {
        const key = r[ownerAcctCol];
        if (!ownerMap[key]) ownerMap[key] = r;
      });

      const leads = filtered.map((r) => {
        const acct = r[acctCol];
        const owner = ownerMap[acct] || {};
        const mailAddr = mailCol ? owner[mailCol] || "" : "";
        const ownerState = mailStateCol
          ? (owner[mailStateCol] || "").toUpperCase().trim()
          : extractState(mailAddr);
        const outOfState = ownerState !== "" && ownerState !== "TX";

        const lead = {
          acct_number: acct,
          property_address: addrCol ? r[addrCol] || "" : "",
          owner_name: nameCol ? owner[nameCol] || "" : "",
          owner_mail_address: mailAddr,
          year_built: yrCol ? parseInt(r[yrCol]) || null : null,
          appraised_value: valCol ? parseFloat(r[valCol]) || null : null,
          unit_count: null,
          out_of_state_owner: outOfState,
          permit_flag: false,
          lead_score: 0,
        };
        lead.lead_score = scoreLead(lead);
        return lead;
      });

      setStatus(`Scored ${leads.length} leads. Uploading to Supabase...`);

      const batchSize = 500;
      let uploaded = 0;

      for (let i = 0; i < leads.length; i += batchSize) {
        const batch = leads.slice(i, i + batchSize);
        const { error } = await supabase
          .from("leads")
          .upsert(batch, { onConflict: "acct_number" });

        if (error) {
          setStatus(`Error at batch ${i}: ${error.message}`);
          setProcessing(false);
          return;
        }
        uploaded += batch.length;
        setProgress(Math.round((uploaded / leads.length) * 100));
        setStatus(`Uploaded ${uploaded}/${leads.length} leads...`);
      }

      setStatus(
        `Done! ${uploaded} leads uploaded. Top scores: ${leads
          .sort((a, b) => b.lead_score - a.lead_score)
          .slice(0, 5)
          .map((l) => `${l.property_address} (${l.lead_score})`)
          .join(", ")}`,
      );
      setProcessing(false);
      if (onDone) onDone();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
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
        Supabase.
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

        {processing && (
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
