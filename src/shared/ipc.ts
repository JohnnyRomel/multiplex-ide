export const IPC = {
  // Config & Environments
  CONFIG_GET_PATH: 'config:get-path',
  CONFIG_RELOAD: 'config:reload',
  CONFIG_UPDATED: 'config:updated',
  ENV_LIST: 'env:list',
  ENV_LIST_SSH_CONFIG: 'env:list-ssh-config',
  ENV_REFRESH: 'env:refresh',
  ENV_ADD_CUSTOM: 'env:add-custom',
  ENV_DELETE_CUSTOM: 'env:delete-custom',
  ENV_UPDATE_SETTINGS: 'env:update-settings',
  ENV_CONNECT: 'env:connect',
  ENV_DISCONNECT: 'env:disconnect',
  ENV_STATUS_CHANGED: 'env:status-changed',
  ENV_GET_HOME: 'env:get-home',
  ENV_GET_GIT_BRANCH: 'env:get-git-branch',
  ENV_GET_GIT_STATUS: 'env:get-git-status',

  // Terminal
  TERM_CREATE: 'term:create',
  TERM_WRITE: 'term:write',
  TERM_RESIZE: 'term:resize',
  TERM_KILL: 'term:kill',
  TERM_RECONNECT: 'term:reconnect',
  TERM_DATA: 'term:data',
  TERM_EXIT: 'term:exit',
  TERM_STATUS: 'term:status',
  TERM_NOTIFICATION: 'term:notification',

  // File System (VFS)
  FS_READ_DIR: 'fs:read-dir',
  FS_STAT: 'fs:stat',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_MKDIR: 'fs:mkdir',
  FS_CREATE_FILE: 'fs:create-file',
  FS_RENAME: 'fs:rename',
  FS_DELETE: 'fs:delete',
  FS_PICK_LOCAL_DIR: 'fs:pick-local-dir',
  FS_PICK_LOCAL_FILES: 'fs:pick-local-files',
  FS_SHOW_IN_FINDER: 'fs:show-in-finder',
  FS_START_NATIVE_DRAG: 'fs:start-native-drag',

  // Transfer Queue
  TRANSFER_ENQUEUE: 'transfer:enqueue',
  TRANSFER_CANCEL: 'transfer:cancel',
  TRANSFER_LIST: 'transfer:list',
  TRANSFER_CLEAR_FINISHED: 'transfer:clear-finished',
  TRANSFER_DOWNLOAD_TO_PICKER: 'transfer:download-to-picker',
  TRANSFER_UPDATE: 'transfer:update',

  // Global Search & Quick Open (Goto Files)
  SEARCH_START: 'search:start',
  SEARCH_CANCEL: 'search:cancel',
  SEARCH_MATCH_BATCH: 'search:match-batch',
  SEARCH_DONE: 'search:done',
  SEARCH_LIST_FILES: 'search:list-files',
  SEARCH_FILES_QUERY: 'search:files-query',
  SEARCH_FILES_CANCEL: 'search:files-cancel'
} as const
