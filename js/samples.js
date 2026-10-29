// Sample sets for the "Load ..." buttons. Paths are relative to the site root.

export const SAMPLE_SETS = {
  tidewater: {
    label: "Tidewater (AWS)",
    files: [
      "samples/aws/tidewater-payments/tidewater-shared-network.json",
      "samples/aws/tidewater-payments/tidewater-prod-app.json",
      "samples/aws/tidewater-payments/tidewater-nonprod-app.json",
      "samples/aws/tidewater-payments/tidewater-data-platform.json",
      "samples/aws/tidewater-payments/tidewater-security-logging.json",
    ],
  },
  larkspur: {
    label: "Larkspur (messy AWS)",
    files: [
      "samples/aws/larkspur-lending/larkspur-prod.json",
      "samples/aws/larkspur-lending/larkspur-legacy.json",
    ],
  },
};

// Fetches the files of one set as [{ path, text }]. `base` is the URL of the site root.
export async function fetchSampleSet(key, base) {
  const set = SAMPLE_SETS[key];
  return Promise.all(set.files.map(async (path) => {
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return { path, text: await res.text() };
  }));
}
