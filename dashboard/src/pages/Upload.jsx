import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";

// B1=Apartments, B2=Duplexes, B3=Triplexes/Fourplexes, B4=Manufactured housing parks
// These are the actual multifamily/apartment codes in HCAD
const MULTIFAMILY_CODES = new Set(["B1", "B2", "B3", "B4"]);

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

  // Out-of-state owner (likely absentee, more motivated to sell/renovate)
  if (lead.out_of_state_owner) s += 20;

  // Age tiers (older = more likely to need construction work)
  const yr = lead.year_built;
  if (yr && yr < 1970) s += 20;
  else if (yr && yr < 1985) s += 15;
  else if (yr && yr < 1995) s += 10;
  else if (yr && yr < 2005) s += 5;

  // Value tiers (higher value = bigger project potential)
  const val = lead.appraised_value;
  if (val && val > 5000000) s += 20;
  else if (val && val > 2000000) s += 15;
  else if (val && val > 1000000) s += 10;
  else if (val && val > 500000) s += 5;

  // Unit count (more units = bigger project)
  const units = lead.unit_count;
  if (units && units > 50) s += 20;
  else if (units && units > 20) s += 15;
  else if (units && units > 10) s += 10;
  else if (units && units > 4) s += 5;

  // Permit flag (has active/problem permits = hot lead)
  if (lead.permit_flag) s += 20;

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
    const buildingFile = e.target.elements.building?.files[0] || null;

    if (!acctFile || !ownersFile) {
      setStatus("Please select real_acct.txt and owners.txt.");
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
      let valIdx = -1;
      // Address columns (may be split across multiple columns)
      let siteAddr1Idx = -1;
      let siteAddr2Idx = -1;
      let siteAddr3Idx = -1;
      // Mail address columns from real_acct
      let mailAddr1Idx = -1;
      let mailAddr2Idx = -1;
      let mailCityIdx = -1;
      let mailStateIdx = -1;
      let mailZipIdx = -1;

      // Store only filtered rows as lightweight objects
      const filtered = [];
      const filteredAccts = new Set();

      const acctResult = await streamLines(
        acctFile,
        (headers) => {
          acctIdx = findColIndex(headers, ["acct", "account", "acct_number"]);
          classIdx = findColIndex(headers, ["state_class", "state_cd", "class_cd", "impr_state_cd"]);
          yrIdx = findColIndex(headers, ["yr_impr", "yr_built", "year_built"]);
          valIdx = findColIndex(headers, ["tot_appr_val", "appraised_value", "total_appraised_value", "appr_val"]);
          // HCAD splits property address into site_addr_1/2/3
          siteAddr1Idx = headers.indexOf("site_addr_1");
          siteAddr2Idx = headers.indexOf("site_addr_2");
          siteAddr3Idx = headers.indexOf("site_addr_3");
          // HCAD has mail address in real_acct itself
          mailAddr1Idx = headers.indexOf("mail_addr_1");
          mailAddr2Idx = headers.indexOf("mail_addr_2");
          mailCityIdx = headers.indexOf("mail_city");
          mailStateIdx = headers.indexOf("mail_state");
          mailZipIdx = headers.indexOf("mail_zip");
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

          // Build property address from split columns
          const addrParts = [siteAddr1Idx, siteAddr2Idx, siteAddr3Idx]
            .filter((i) => i !== -1)
            .map((i) => (cols[i] || "").trim())
            .filter(Boolean);
          const propertyAddress = addrParts.join(" ").replace(/\s+/g, " ").trim();

          // Build mailing address from split columns
          const mailParts = [mailAddr1Idx, mailAddr2Idx, mailCityIdx, mailStateIdx, mailZipIdx]
            .filter((i) => i !== -1)
            .map((i) => (cols[i] || "").trim())
            .filter(Boolean);
          const mailAddress = mailParts.join(" ").replace(/\s+/g, " ").trim();
          const mailState = mailStateIdx !== -1 ? (cols[mailStateIdx] || "").trim().toUpperCase() : "";

          const acct = cols[acctIdx] || "";
          const stateClass = classIdx !== -1 ? (cols[classIdx] || "").toUpperCase().trim() : "";
          filtered.push({
            acct_number: acct,
            property_address: propertyAddress,
            owner_mail_address: mailAddress,
            mail_state: mailState,
            state_class: stateClass,
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
      // owners.txt has: acct, ln_num, name, aka, pct_own
      let ownerNameIdx = -1;
      let ownerAcctIdx = -1;
      const ownerMap = {};

      await streamLines(
        ownersFile,
        (headers) => {
          ownerAcctIdx = findColIndex(headers, ["acct", "account", "acct_number"]);
          ownerNameIdx = findColIndex(headers, ["name", "owner_name", "owner"]);
          if (ownerAcctIdx === -1) ownerAcctIdx = 0;
        },
        (cols) => {
          const acct = cols[ownerAcctIdx] || "";
          // Only store owners that match our filtered properties
          if (filteredAccts.has(acct) && !ownerMap[acct]) {
            ownerMap[acct] = {
              name: ownerNameIdx !== -1 ? cols[ownerNameIdx] || "" : "",
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

      // --- Pass 3 (optional): Stream building_res.txt for unit counts ---
      const unitMap = {};
      if (buildingFile) {
        setStatus(
          `Reading building data (${(buildingFile.size / 1024 / 1024).toFixed(0)} MB)...`,
        );
        setProgress(65);

        let bldAcctIdx = -1;
        let unitsIdx = -1;

        await streamLines(
          buildingFile,
          (headers) => {
            bldAcctIdx = findColIndex(headers, ["acct", "account", "acct_number"]);
            // HCAD building_res column for unit count - try all known variants
            unitsIdx = findColIndex(headers, [
              "units", "nbr_units", "no_of_units", "unit_count",
              "nbr_of_units", "nbr_living_units", "living_units",
              "num_units", "total_units",
            ]);
            if (bldAcctIdx === -1) bldAcctIdx = 0;
            setDebug(
              `Building file: ${headers.length} columns. ` +
              `Acct col: ${bldAcctIdx >= 0 ? headers[bldAcctIdx] : "NOT FOUND"}. ` +
              `Units col: ${unitsIdx >= 0 ? headers[unitsIdx] : "NOT FOUND - cols: " + headers.slice(0, 20).join(", ")}`,
            );
          },
          (cols) => {
            const acct = cols[bldAcctIdx] || "";
            if (!filteredAccts.has(acct)) return;
            if (unitsIdx !== -1) {
              const u = parseInt(cols[unitsIdx]);
              if (!isNaN(u) && u > 0) {
                // Keep the highest unit count per account (multiple building records possible)
                unitMap[acct] = Math.max(unitMap[acct] || 0, u);
              }
            }
          },
          (bytes, total, lines) => {
            const pct = 65 + Math.round((bytes / total) * 5);
            setProgress(pct);
            setStatus(
              `Reading building data: ${lines.toLocaleString()} rows, ${Object.keys(unitMap).length} unit counts...`,
            );
          },
        );
      }

      setStatus(`Scoring ${filtered.length} leads...`);
      setProgress(72);

      // --- Score leads ---
      // Mail address from real_acct (prop), owner name from owners.txt, units from building_res
      const leads = filtered.map((prop) => {
        const owner = ownerMap[prop.acct_number] || {};
        const ownerState = prop.mail_state || extractState(prop.owner_mail_address || "");
        const outOfState = ownerState !== "" && ownerState !== "TX";

        const lead = {
          acct_number: prop.acct_number,
          property_address: prop.property_address,
          owner_name: owner.name || "",
          owner_mail_address: prop.owner_mail_address || "",
          state_class: prop.state_class || "",
          year_built: prop.year_built,
          appraised_value: prop.appraised_value,
          unit_count: unitMap[prop.acct_number] || null,
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

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            building_res.txt
            <span className="text-gray-400 font-normal">
              {" "}
              (from Real_building_land folder - optional, adds unit counts)
            </span>
          </label>
          <input
            name="building"
            type="file"
            accept=".txt,.csv"
            disabled={processing}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
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
