import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { RestRequest } from '../../shared/ipc.ts'
import { CredentialService } from '../backend/credentials.ts'

import { isShellPage } from '../paths.ts'

function trusted(event: IpcMainInvokeEvent): boolean {
  return Boolean(event?.senderFrame && event.senderFrame === event.sender?.mainFrame && isShellPage(event.senderFrame.url))
}

export function registerCredentialsIpc(backend: {
  rest(request: RestRequest): Promise<unknown>
  prepareCredentialWrite(): () => void
}): void {
  const service = new CredentialService(request => backend.rest(request), () => backend.prepareCredentialWrite())
  ipcMain.handle(IPC.credentialsProviderEndpoints, async event => trusted(event) ? service.providerEndpoints() : { ok: false })
  ipcMain.handle(IPC.credentialsProviderCatalog, async event => trusted(event) ? service.providerCatalog() : { ok: false })
  ipcMain.handle(IPC.credentialsList, async event => trusted(event) ? service.list() : { ok: false })
  ipcMain.handle(IPC.credentialsSave, async (event, name: unknown, value: unknown, mode: unknown = 'update') => trusted(event) ? service.save(name, value, mode) : { ok: false })
  ipcMain.handle(IPC.credentialsSaveProvider, async (event, name: unknown, value: unknown) => trusted(event) ? service.saveProvider(name, value) : { ok: false })
  ipcMain.handle(IPC.credentialsRemove, async (event, name: unknown, confirmed: unknown) => trusted(event) ? service.remove(name, confirmed) : { ok: false })
}
