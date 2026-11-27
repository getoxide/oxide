import { memo, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDirectoryFillIcon,
  FileIcon,
} from "@primer/octicons-react";
import { commands, type FileEntry } from "../bindings";
import { Skeleton } from "../shared/Skeleton";
import { showContextMenu } from "../shared/ContextMenu";
import { copyTextToClipboard, joinProjectPath, revealInFileManagerLabel } from "../shared/platform";
import { OXIDE_FILE_MIME } from "../terminal/useTerminalTransfer";

export const EditorFileTree = memo(function EditorFileTree({
  projectId,
  rootPath,
  selected,
  onOpen,
  onKeep,
  revision,
  empty,
}: {
  projectId: number;
  rootPath?: string;
  selected: string | null;
  /** Single click: opens or previews the file. */
  onOpen: (path: string) => void;
  /** Double click: keeps the file open. */
  onKeep?: (path: string) => void;
  revision: number;
  /** Rendered in place of the tree when the checkout root holds no entries. */
  empty?: React.ReactNode;
}) {
  const [directories, setDirectories] = useState<Record<string, FileEntry[]>>(
    {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [error, setError] = useState<string | null>(null);
  async function load(path: string) {
    try {
      const result = await commands.listDir(projectId, path);
      if (result.status === "error") setError(result.error.message);
      else setDirectories((previous) => ({ ...previous, [path]: result.data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    let active = true;
    void commands
      .listDir(projectId, "")
      .then((result) => {
        if (!active) return;
        if (result.status === "error") setError(result.error.message);
        else setDirectories((previous) => ({ ...previous, "": result.data }));
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [revision, projectId]);
  // The selected file's folders open so it is visible in the list.
  const [revealed, setRevealed] = useState<string | null>(null);
  if (selected !== revealed) {
    setRevealed(selected);
    const parts = (selected ?? "").split("/").slice(0, -1);
    const folders = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    if (folders.some((f) => !expanded.has(f))) setExpanded(new Set([...expanded, ...folders]));
  }
  useEffect(() => {
    const parts = (selected ?? "").split("/").slice(0, -1);
    parts.forEach((_, i) => {
      const folder = parts.slice(0, i + 1).join("/");
      if (!directories[folder]) void load(folder);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!directories[path]) void load(path);
  }
  function render(path: string, depth: number) {
    const entries = directories[path];
    if (!entries) return <Skeleton kind="tree" rows={5} label="Loading files…"/>;
    return entries.map((entry) => (
      <div
        key={entry.path}
        role="treeitem"
        aria-selected={!entry.isDir && selected === entry.path}
        aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
      >
        <button
          className={`files-row${selected === entry.path ? " files-row-selected" : ""}`}
          title={entry.path}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(event) => {
            const fullPath = rootPath ? joinProjectPath(rootPath, entry.path) : entry.path;
            event.dataTransfer.setData(OXIDE_FILE_MIME, fullPath);
            event.dataTransfer.setData("text/plain", fullPath);
            event.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() =>
            entry.isDir ? toggle(entry.path) : onOpen(entry.path)
          }
          onDoubleClick={() => {
            if (!entry.isDir) onKeep?.(entry.path);
          }}
          onContextMenu={(event) => {
            const fullPath = rootPath ? joinProjectPath(rootPath, entry.path) : entry.path;
            showContextMenu(event, [
              ...(entry.isDir
                ? [{ label: expanded.has(entry.path) ? "Collapse" : "Expand", run: () => toggle(entry.path) }]
                : [{ label: "Open in Code", run: () => (onKeep ?? onOpen)(entry.path) }]),
              { label: "Copy path", run: () => copyTextToClipboard(fullPath) },
              { label: revealInFileManagerLabel(), run: () => void commands.revealInFinder(projectId), separatorBefore: true },
            ]);
          }}
          onKeyDown={(e) => {
            if (!entry.isDir && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              (onKeep ?? onOpen)(entry.path);
              return;
            }
            if (
              entry.isDir &&
              ((e.key === "ArrowRight" && !expanded.has(entry.path)) ||
                (e.key === "ArrowLeft" && expanded.has(entry.path)))
            ) {
              e.preventDefault();
              toggle(entry.path);
            }
          }}
        >
          <span className="files-chevron">
            {entry.isDir &&
              (expanded.has(entry.path) ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              ))}
          </span>
          {entry.isDir ? (
            <FileDirectoryFillIcon size={14} />
          ) : (
            <FileIcon size={14} />
          )}
          <span className="files-name">{entry.name}</span>
        </button>
        {entry.isDir && expanded.has(entry.path) && (
          <div role="group">{render(entry.path, depth + 1)}</div>
        )}
      </div>
    ));
  }
  const root = directories[""];
  // Keep the fetch alive while empty: `revision` can bring files back, and the tree must remount then.
  if (empty && root && root.length === 0) return <>{empty}</>;
  return (
    <div className="editor-file-tree" role="tree" aria-label="Project files">
      {error && (
        <p className="error files-note" role="alert">
          {error}
        </p>
      )}
      {render("", 0)}
    </div>
  );
});
