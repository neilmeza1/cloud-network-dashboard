// Format detection. Every uploaded file names its format in `_export.schema`.

export const SCHEMAS = {
  "aws-account-inventory/1.0": "aws",
  "azure-subscription-inventory/1.0": "azure",
  "gcp-project-inventory/1.0": "gcp",
};

// Returns "aws" | "azure" | "gcp", or throws an Error that names the file.
export function detectFormat(doc, file) {
  const schema = doc && doc._export && doc._export.schema;
  if (!schema) {
    throw new Error(`${file}: no _export.schema field, so the format cannot be detected.`);
  }
  const format = SCHEMAS[schema];
  if (!format) {
    const known = Object.keys(SCHEMAS).join(", ");
    throw new Error(`${file}: unknown schema "${schema}". Expected one of: ${known}.`);
  }
  return format;
}
