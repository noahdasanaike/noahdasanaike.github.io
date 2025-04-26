// Import PapaParse library (must be accessible at this path relative to the worker)
importScripts('https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js');

// --- Helper Functions (needed within the worker) ---

// Calculate bounds from data points
function calculateDataBounds(data) {
    if (!data || data.length === 0) return null;

    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;

    data.forEach(point => {
        if (point.lat > maxLat) maxLat = point.lat;
        if (point.lat < minLat) minLat = point.lat;
        if (point.lng > maxLng) maxLng = point.lng;
        if (point.lng < minLng) minLng = point.lng;
    });

    // Add a small buffer
    const latBuffer = (maxLat - minLat) * 0.1;
    const lngBuffer = (maxLng - minLng) * 0.1;

    // Handle cases where buffer might be zero (single point)
    const finalLatBuffer = latBuffer === 0 ? 0.1 : latBuffer;
    const finalLngBuffer = lngBuffer === 0 ? 0.1 : lngBuffer;


    return {
        north: maxLat + finalLatBuffer,
        south: minLat - finalLatBuffer,
        east: maxLng + finalLngBuffer,
        west: minLng - finalLngBuffer
    };
}

// --- Main Data Processing Logic (moved from index.html) ---

function processElectionData(data, filePath, electionType) {
    let coordGroups = {};
    let allLocations = [];
    let partyColors = {};

    // Identify columns (same logic as before)
    const partyColumns = {};
    const possibleVoteColumns = [];

    if (data.length > 0) {
        const firstRow = data[0];
        const allColumns = Object.keys(firstRow);

        const partyCol = allColumns.find(col =>
            col.toLowerCase() === 'party' ||
            col.toLowerCase() === 'party_name' ||
            col.toLowerCase() === 'partyname'
        );
        const votesCol = allColumns.find(col =>
            col.toLowerCase() === 'votes' ||
            col.toLowerCase() === 'party_votes' ||
            col.toLowerCase() === 'partyvotes'
        );

        if (partyCol && votesCol) {
            partyColumns[partyCol] = votesCol;
        } else {
            allColumns.forEach(col => {
                 if (col.match(/party[0-9]*(_name)?$/i) ||
                     col.match(/^p[0-9]+_n$/i) ||
                     col.toLowerCase().includes("party") ||
                     col.match(/^party_[a-z0-9_]+$/i) ||
                     col.match(/party_[a-z]/i)) {

                    const baseCol = col.replace(/_name$/i, '').replace(/_n$/i, '');
                    const voteCol = allColumns.find(c =>
                        c === `${baseCol}_votes` ||
                        c === `${baseCol}_v` ||
                        c === baseCol.replace('party', 'votes') ||
                        c === baseCol.replace('name', 'votes')
                    );

                    if (voteCol) {
                        partyColumns[col] = voteCol;
                    } else {
                        const possibleVotes = allColumns.find(c =>
                            c.toLowerCase() === 'votes' ||
                            c.toLowerCase().includes('vote')
                        );
                        if (possibleVotes) {
                            partyColumns[col] = possibleVotes;
                        } else {
                            possibleVoteColumns.push(col);
                        }
                    }
                } else if (col.match(/votes[0-9]*$/i) ||
                           col.match(/^v[0-9]+$/i) ||
                           col.match(/^p[0-9]+_v$/i)) {
                    possibleVoteColumns.push(col);
                }
            });

            if (Object.keys(partyColumns).length === 0) {
                const partyNamePattern = /^p([0-9]+)$/i;
                allColumns.forEach(col => {
                    const match = col.match(partyNamePattern);
                    if (match) {
                        const partyNumber = match[1];
                        const voteCol = allColumns.find(c =>
                            c.toLowerCase() === `v${partyNumber}` ||
                            c.toLowerCase() === `votes${partyNumber}`
                        );
                        if (voteCol) {
                            partyColumns[col] = voteCol;
                        }
                    }
                });
            }
        }
    }

    // Process each data point
    data.forEach(row => {
        if (!row.lat || !row.lng || isNaN(parseFloat(row.lat)) || isNaN(parseFloat(row.lng))) {
            return;
        }

        const lat = parseFloat(row.lat);
        const lng = parseFloat(row.lng);
        const coordKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;

        // Location Name extraction (same logic)
        const possibleNameFields = ['name', 'NAME', 'title', 'location', 'district', 'locality', 'municipality', 'region', 'state', 'country', 'name1', 'name2', 'name3'];
        let locationName = "Unknown Location";
        for (const field of possibleNameFields) {
            if (row[field]) {
                locationName = row[field];
                break;
            }
        }
        const nameHierarchy = [];
        const nameFields = [];
        Object.keys(row).forEach(key => {
            if (/^name\d+(_[a-z]|_imp)?$/i.test(key)) {
                nameFields.push(key);
            }
        });
        nameFields.sort((a, b) => { /* Sorting logic as before */
            const matchA = a.match(/^name(\d+)(_[a-z]|_imp)?$/i);
            const matchB = b.match(/^name(\d+)(_[a-z]|_imp)?$/i);
            if (matchA && matchB) {
                const numA = parseInt(matchA[1]); const numB = parseInt(matchB[1]);
                if (numA !== numB) return numA - numB;
                const suffixA = matchA[2] || ''; const suffixB = matchB[2] || '';
                return suffixA.localeCompare(suffixB);
            } return a.localeCompare(b);
        });
        nameFields.forEach(field => { if (row[field]) { nameHierarchy.push({ field: field, value: row[field] }); } });
        if (nameHierarchy.length > 0) {
            const mainNames = nameHierarchy.filter(item => !item.field.includes('_'));
            if (mainNames.length > 0) locationName = mainNames.map(item => item.value).join(', ');
            else locationName = nameHierarchy[0].value;
        }

        // Total Votes extraction (same logic)
        const possibleTotalVotesFields = ['total_votes', 'votes_total', 'totalvotes', 'valid_votes', 'valid_ballots', 'valid'];
        let totalVotes = 0;
        for (const field of possibleTotalVotesFields) {
            if (row[field] !== undefined && !isNaN(parseFloat(row[field]))) {
                totalVotes = parseFloat(row[field]); break;
            }
        }
        if (totalVotes === 0) {
             if (row.votes !== undefined && !isNaN(parseFloat(row.votes))) {
                totalVotes = parseFloat(row.votes);
             } else if (Object.keys(partyColumns).length > 0) {
                try {
                    const entries = Object.entries(partyColumns);
                    if (entries.length > 0) {
                        const [nameCol, voteCol] = entries[0];
                        if (row[voteCol] !== undefined && !isNaN(parseFloat(row[voteCol]))) {
                            totalVotes = parseFloat(row[voteCol]);
                        }
                    }
                } catch (e) { /* ignore */ }
             }
        }


        // Registered Voters & Turnout (same logic)
        const possibleRegFields = ['reg', 'registered', 'evp', 'eligible', 'registered_voters', 'electorate'];
        let registeredVoters = 0;
        for (const field of possibleRegFields) {
            if (row[field] && !isNaN(parseFloat(row[field]))) {
                registeredVoters = parseFloat(row[field]); break;
            }
        }
        let turnout = null;
        if (row.turnout && !isNaN(parseFloat(row.turnout))) turnout = parseFloat(row.turnout);
        else if (row.turnout_reg && !isNaN(parseFloat(row.turnout_reg))) turnout = parseFloat(row.turnout_reg);
        else if (totalVotes > 0 && registeredVoters > 0) turnout = totalVotes / registeredVoters;

        // Create location object
        const location = {
            latitude: lat, longitude: lng, name: locationName,
            total_votes: totalVotes, reg: registeredVoters, turnout: turnout,
            fullDetails: { ...row }, nameHierarchy: nameHierarchy, parties: []
        };

        // Extract Party Data (same logic, including Albania-specific handling)
        const isNA = (val) => { /* NA check logic */
            if (!val) return true;
            if (typeof val === 'string') { const lower = val.toLowerCase(); return lower === 'na' || lower === 'n/a' || lower === 'null' || lower === 'none'; }
            return false;
        };

        if (row.party !== undefined && row.votes !== undefined) {
            let partyName = row.party || "";
            if (row.party_b && !isNA(row.party_b)) partyName += (partyName ? "\n" : "") + row.party_b;
            if (row.party_c && !isNA(row.party_c)) partyName += (partyName ? "\n" : "") + row.party_c;
            if (row.party_d && !isNA(row.party_d)) partyName += (partyName ? "\n" : "") + row.party_d;
            const votes = typeof row.votes === 'number' ? row.votes : parseInt(row.votes) || 0;
            location.parties.push({ name: partyName || "Unknown Party", votes: votes, vote_share: votes / (location.total_votes || 1) });
        } else if (row.Party !== undefined && row.Votes !== undefined) {
            const votes = typeof row.Votes === 'number' ? row.Votes : parseInt(row.Votes) || 0;
            location.parties.push({ name: row.Party, votes: votes, vote_share: votes / (location.total_votes || 1) });
        } else {
            if (Object.keys(partyColumns).length === 1) {
                 const [[nameCol, voteCol]] = Object.entries(partyColumns);
                 if (row[nameCol] && row[voteCol] !== undefined) {
                    const voteCount = typeof row[voteCol] === 'number' ? row[voteCol] : parseInt(row[voteCol]) || 0;
                    location.parties.push({ name: row[nameCol], votes: voteCount, vote_share: voteCount / (location.total_votes || 1) });
                 }
            } else {
                Object.entries(partyColumns).forEach(([nameCol, voteCol]) => {
                    if (row[nameCol] && row[voteCol] !== undefined) {
                        const voteCount = typeof row[voteCol] === 'number' ? row[voteCol] : parseInt(row[voteCol]) || 0;
                        location.parties.push({ name: row[nameCol], votes: voteCount, vote_share: voteCount / (location.total_votes || 1) });
                    }
                });
            }
        }

        // Find winning party (same logic)
        if (location.parties.length > 0) {
            location.parties.sort((a, b) => b.votes - a.votes);
            location.winning_party = location.parties[0].name;
            location.winning_share = location.parties[0].vote_share;
        } else {
            location.winning_party = "Unknown";
            location.winning_share = 0;
        }

        // Grouping logic (same logic)
        let locationKey = '';
        if (location.nameHierarchy && location.nameHierarchy.length > 0) {
            locationKey = location.nameHierarchy.map(item => `${item.field}:${item.value}`).join('|');
        } else {
            locationKey = location.name;
        }
        const fullLocationKey = `${lat},${lng},${locationKey}`;

        if (!coordGroups[coordKey]) {
            coordGroups[coordKey] = { latitude: lat, longitude: lng, locations: {}, locationKeys: [] }; // Use Array for locationKeys, Set doesn't serialize well
        }

        if (!coordGroups[coordKey].locationKeys.includes(fullLocationKey)) {
            coordGroups[coordKey].locationKeys.push(fullLocationKey);
            coordGroups[coordKey].locations[fullLocationKey] = location;
            allLocations.push(location);
        } else {
            const existingLocation = coordGroups[coordKey].locations[fullLocationKey];
            if (location.parties.length > 0) {
                location.parties.forEach(party => {
                    const existingParty = existingLocation.parties.find(p => p.name === party.name);
                    if (!existingParty) {
                        existingLocation.parties.push(party);
                    }
                });
                // Recalculate winning party for the aggregated location
                 existingLocation.parties.sort((a, b) => b.votes - a.votes);
                 if (existingLocation.parties.length > 0) {
                    existingLocation.winning_party = existingLocation.parties[0].name;
                    existingLocation.winning_share = existingLocation.parties[0].vote_share;
                 }
            }
        }
    });

    // Assign colors to parties (using a fixed palette within the worker)
    const colorPalette = [ /* Same palette as before */
        '#D32F2F', '#1976D2', '#388E3C', '#F57C00', '#C2185B', '#0097A7',
        '#455A64', '#7B1FA2', '#5D4037', '#00796B', '#6D4C41', '#512DA8',
        '#004D40', '#3E2723', '#263238'
    ];
    const allPartiesSet = new Set();
    allLocations.forEach(location => {
        location.parties.forEach(party => {
            allPartiesSet.add(party.name);
        });
    });
    const partiesArray = Array.from(allPartiesSet); // Order might vary, but consistent within one run
    partiesArray.forEach((party, index) => {
        partyColors[party] = colorPalette[index % colorPalette.length];
    });

    // Calculate overall bounds
    const dataBounds = calculateDataBounds(allLocations.map(loc => ({ lat: loc.latitude, lng: loc.longitude })));

    // Return processed data
    return { coordGroups, allLocations, partyColors, dataBounds };
}


// --- Web Worker Event Listener ---
self.onmessage = async function(event) {
    const { csvUrl, filePath, electionType } = event.data;
    console.log(`Worker received job for: ${csvUrl}`); // Worker logging

    try {
        // Fetch the CSV data
        console.log("Worker fetching CSV...");
        const response = await fetch(csvUrl);
        if (!response.ok) {
            throw new Error(`Worker failed to fetch CSV: ${response.status} ${response.statusText}`);
        }
        const csvText = await response.text();
        console.log("Worker fetched CSV text (length):", csvText.length);

        // --- Parse CSV using PapaParse ---
        console.log("Worker starting PapaParse...");
        Papa.parse(csvText, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            delimiter: ",", 
            encoding: "UTF-8",
            complete: function(results) {
                console.log("Worker PapaParse complete. Errors:", results.errors.length);

                // Check for parsing errors *first*
                if (results.errors && results.errors.length > 0) {
                    // Construct a more informative error message
                    const errorMessages = results.errors.map(e => `Row ${e.row}: ${e.message} (${e.code})`).join('; ');
                    self.postMessage({
                        status: 'error',
                        message: `Error parsing CSV: ${errorMessages}` // Send back specific errors
                    });
                    return; // Stop processing
                }

                if (!results.data || results.data.length === 0) {
                    self.postMessage({
                        status: 'error',
                        message: "No data rows found in the CSV file after parsing."
                    });
                    return;
                }
                console.log("Worker parsed rows:", results.data.length);

                // --- Column Identification Logic ---
                const firstRow = results.data[0];
                const keys = Object.keys(firstRow);
                let latColumn = null, lngColumn = null;
                // Find lat/lng columns (same logic as before)
                for (const key of keys) { const lowerKey = key.toLowerCase(); if (!latColumn && (lowerKey === 'latitude' || lowerKey === 'lat')) latColumn = key; if (!lngColumn && (lowerKey === 'longitude' || lowerKey === 'lng' || lowerKey === 'long')) lngColumn = key; }
                if (!latColumn || !lngColumn) { for (const key of keys) { const lowerKey = key.toLowerCase(); if (!latColumn && (lowerKey === 'y' || lowerKey.startsWith('lat') || lowerKey.endsWith('_lat') || lowerKey.includes('_lat_'))) latColumn = key; if (!lngColumn && (lowerKey === 'x' || lowerKey.startsWith('lon') || lowerKey.endsWith('_lon') || lowerKey.endsWith('_lng') || lowerKey.includes('_lon_') || lowerKey.includes('_lng_'))) lngColumn = key; } }

                if (!latColumn || !lngColumn) {
                    self.postMessage({ status: 'error', message: `Could not find required coordinate columns (lat/lng). Available: ${keys.join(', ')}` });
                    return;
                }
                console.log(`Worker identified coordinate columns: lat=${latColumn}, lng=${lngColumn}`);

                // --- Filter and Process Data ---
                const data = results.data.filter(row => row[latColumn] != null && row[lngColumn] != null && !isNaN(parseFloat(row[latColumn])) && !isNaN(parseFloat(row[lngColumn])) );
                data.forEach(row => { row.lat = parseFloat(row[latColumn]); row.lng = parseFloat(row[lngColumn]); }); // Ensure they are numbers

                if (data.length === 0) {
                    self.postMessage({ status: 'error', message: "No rows with valid numeric coordinates found." });
                    return;
                }
                console.log("Worker rows with valid coordinates:", data.length);

                console.log("Worker processing election data...");
                // *** NOTE: processElectionData should now exist in this worker file ***
                if (typeof processElectionData !== 'function') {
                     throw new Error("processElectionData function is not defined in the worker.");
                }
                const processedData = processElectionData(data, filePath, electionType);
                console.log("Worker finished processing election data.");

                // Send processed data back
                self.postMessage({
                    status: 'success',
                    data: processedData,
                    rowCount: data.length
                });
            },
            error: function(error) {
                // Send OTHER parsing errors back (e.g., file read error - less likely here)
                console.error("Worker PapaParse file read/generic error:", error);
                self.postMessage({
                    status: 'error',
                    message: `PapaParse encountered an error: ${error.message}`
                });
            }
        }); // End of Papa.parse call

    } catch (error) {
        // Catch errors from fetch or other synchronous code in the handler
        console.error("Error within worker onmessage handler:", error);
        self.postMessage({
            status: 'error',
            message: `Worker error: ${error.message}`
        });
    }
};

// Handle potential errors during worker initialization itself
self.onerror = function(event) {
     console.error("Worker global error:", event);
     // Attempt to send message back if possible
     try {
        self.postMessage({
            status: 'error',
            message: `Worker initialization or unhandled error: ${event.message}`
        });
     } catch(e) {
        // Ignore if posting fails (worker might be terminated)
     }
};

console.log("Data processor worker initialized."); // Log worker startup