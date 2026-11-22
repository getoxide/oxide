import { useState } from "react";
import { FileDirectoryIcon } from "@primer/octicons-react";
import { EditorFileTree } from "./EditorFileTree";

interface FilesPanelProps {
  projectId: number;
  rootPath?: string;
  /** Changes after checkout mutations (commits, checkouts, terminal commands), so the tree refetches. */
  revision: number;
  /** Opens the file in the Project's central Code workspace. */
  onOpenFile: (path: string) => void;
}

/** The tree belongs to one checkout, so a different one remounts it. */
export function FilesPanel(props: FilesPanelProps) {
  return <FilesExplorer key={props.projectId} {...props} />;
}

/** The Files view: a full-width navigator. A click selects; a double click opens Code. */
function FilesExplorer({ projectId, rootPath, revision, onOpenFile }: FilesPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="files files-navigation" aria-label="Files">
      <div className="files-tree">
        <EditorFileTree
          projectId={projectId}
          rootPath={rootPath}
          selected={selected}
          onOpen={(path) => setSelected(path)}
          onKeep={onOpenFile}
          revision={revision}
          empty={(
            <section className="surface-empty">
              <FileDirectoryIcon size={32} />
              <p className="surface-empty-title">No files.</p>
              <p className="surface-empty-description">This checkout does not have any files yet.</p>
            </section>
          )}
        />
      </div>
    </section>
  );
}
