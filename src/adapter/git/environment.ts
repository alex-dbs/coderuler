export function isolatedGitEnvironment(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_IMPLICIT_WORK_TREE',
    'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_NAMESPACE', 'GIT_CONFIG',
  ]) delete isolated[key];
  return isolated;
}
