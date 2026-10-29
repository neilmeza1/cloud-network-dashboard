// Turns picked or dropped files into [{ path, text }]. `path` keeps the folder
// (webkitRelativePath, or the dropped entry's path) so files group into companies by folder.

const isJson = (name) => /\.json$/i.test(name) && !name.startsWith(".");

async function toInputs(pairs) {
  const ignored = [];
  const inputs = [];
  for (const { file, path } of pairs) {
    if (!isJson(file.name)) { ignored.push(path); continue; }
    inputs.push({ path, text: await file.text() });
  }
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  return { inputs, ignored };
}

// From <input type="file" multiple> or <input type="file" webkitdirectory>.
export function fromFileList(fileList) {
  return toInputs([...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
}

// From a drop event. Entries must be taken synchronously, before the first await.
export function fromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return fromFileList(dataTransfer.files);
  return (async () => {
    const pairs = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        pairs.push({ file, path: entry.fullPath.replace(/^\//, "") });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    };
    for (const e of entries) await walk(e);
    return toInputs(pairs);
  })();
}
