import { useEffect, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { toast } from 'sonner'
import { RemoteStepBody, useRemoteRepo } from '../sidebar/AddRepoSteps'
import { SshTargetForm, EMPTY_FORM, type EditingTarget } from '../settings/SshTargetForm'
import type { Repo } from '../../../../shared/types'

type RemoteRepoStepProps = {
  onBack: () => void
  onRemoteAdded: (repo: Repo) => void | Promise<void>
  // Why: not-a-git-repo silently retries with kind: 'folder' inside this step
  // (mirrors the local 'Open a folder' fallback at use-onboarding-flow.ts).
  // The wizard caller decides what to do with the resulting folder repo.
  onRetryAsFolder: (args: { connectionId: string; remotePath: string }) => Promise<void>
  // Why: the silent folder-retry path runs in the wizard controller (not in
  // useRemoteRepo), so its busy/error state lives on `flow.*`. Surface it
  // here or the user gets no feedback while the retry is in flight, and no
  // visible error if it fails.
  busyLabel: string | null
  error: string | null
}

export function RemoteRepoStep({
  onBack,
  onRemoteAdded,
  onRetryAsFolder,
  busyLabel,
  error
}: RemoteRepoStepProps): React.JSX.Element {
  // Why: nested form view replaces the Settings deep-link the dialog uses,
  // because deep-linking out of the wizard would render Settings under the
  // wizard's z-[100] overlay.
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState<EditingTarget>(EMPTY_FORM)

  const {
    sshTargets,
    selectedTargetId,
    remotePath,
    remoteError,
    isAddingRemote,
    setSelectedTargetId,
    setRemotePath,
    setRemoteError,
    handleOpenRemoteStep,
    handleAddRemoteRepo,
    handleConnectTarget
  } = useRemoteRepo({
    onRemoteAdded,
    onNonGitFolder: ({ connectionId, remotePath }) => {
      void onRetryAsFolder({ connectionId, remotePath })
    }
  })

  // Why: hook gates the SSH-target listing IPC behind handleOpenRemoteStep
  // because AddRepoDialog only fires it when navigating to the remote step.
  // The wizard mounts this component when the user clicks the SSH CTA, so we
  // fire the listing once on mount.
  useEffect(() => {
    void handleOpenRemoteStep()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only.
  }, [])

  const handleSaveTarget = async (): Promise<void> => {
    if (!form.host.trim() || !form.username.trim()) {
      toast.error('Host and username are required')
      return
    }
    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.error('Port must be between 1 and 65535')
      return
    }
    const graceSeconds = parseInt(form.relayGracePeriodSeconds, 10)
    if (isNaN(graceSeconds) || graceSeconds < 60 || graceSeconds > 3600) {
      toast.error('Relay grace period must be between 60 and 3600 seconds')
      return
    }
    const target = {
      label: form.label.trim() || `${form.username}@${form.host}`,
      configHost: form.configHost.trim() || form.host.trim(),
      host: form.host.trim(),
      port,
      username: form.username.trim(),
      relayGracePeriodSeconds: graceSeconds,
      ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
      ...(form.proxyCommand.trim() ? { proxyCommand: form.proxyCommand.trim() } : {}),
      ...(form.jumpHost.trim() ? { jumpHost: form.jumpHost.trim() } : {})
    }
    try {
      await window.api.ssh.addTarget({ target })
      toast.success('Target added')
      setShowAddForm(false)
      setForm(EMPTY_FORM)
      // Why: re-list targets so the new one shows up + auto-selects on connect.
      await handleOpenRemoteStep()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save target')
    }
  }

  if (showAddForm) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => {
            setShowAddForm(false)
            setForm(EMPTY_FORM)
          }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3" />
          Back
        </button>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Add SSH target</h2>
          <p className="text-[13px] text-muted-foreground">
            Configure a remote host. You can edit or remove it later in Settings.
          </p>
        </div>
        <SshTargetForm
          editingId={null}
          form={form}
          onFormChange={setForm}
          onSave={() => void handleSaveTarget()}
          onCancel={() => {
            setShowAddForm(false)
            setForm(EMPTY_FORM)
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3" />
        Back
      </button>

      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Open remote project</h2>
        <p className="text-[13px] text-muted-foreground">
          Choose a connected SSH target and enter the path to a Git repository.
        </p>
      </div>

      <RemoteStepBody
        sshTargets={sshTargets}
        selectedTargetId={selectedTargetId}
        remotePath={remotePath}
        remoteError={remoteError}
        isAddingRemote={isAddingRemote}
        onSelectTarget={(id) => {
          setSelectedTargetId(id)
          setRemoteError(null)
        }}
        onRemotePathChange={(value) => {
          setRemotePath(value)
          setRemoteError(null)
        }}
        onAdd={handleAddRemoteRepo}
        // Why: the wizard renders the SSH-target form inline (see showAddForm
        // branch above) instead of deep-linking to Settings, because Settings
        // would render under the wizard's z-[100] overlay.
        onOpenSshSettings={() => setShowAddForm(true)}
        onConnectTarget={handleConnectTarget}
        renderBrowseHeader={() => (
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Browse remote filesystem</h2>
            <p className="text-[13px] text-muted-foreground">
              Navigate to a directory and click Select to choose it.
            </p>
          </div>
        )}
      />

      {busyLabel && (
        <div className="rounded-lg border border-blue-400/30 bg-blue-400/10 px-4 py-2.5 text-sm text-blue-700 dark:text-blue-200">
          {busyLabel}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-700 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  )
}
