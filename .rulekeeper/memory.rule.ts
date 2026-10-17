import BigNumber from 'bignumber.js';

import { Rule, pass, scopes, violation, type CheckResult, type ScopeSubject, type Subject } from 'rulekeeper';

import { isPresent } from './presence.ts';

type MemoryResources = Record<'requests' | 'limits', { memory: string }>;

const bytesPerUnit: Readonly<Record<string, string>> = {
  k: '1000',
  M: '1000000',
  G: '1000000000',
};

function parseMemoryBytes(value: string): BigNumber {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([kMG])$/.exec(value);
  if (!match) throw new Error(`Invalid memory quantity: ${value}`);
  return new BigNumber(match[1]!).multipliedBy(bytesPerUnit[match[2]!]!);
}

export default class MemoryRatio extends Rule<MemoryResources> {
  files = ['tests/manual/*.yml'];

  scope = scopes.yaml<MemoryResources>({ path: '$.*.container.resources' });

  filter(subject: ScopeSubject<MemoryResources>): boolean {
    return isPresent(subject.data, 'requests', 'memory') && isPresent(subject.data, 'limits', 'memory');
  }

  check = (subject: Subject<MemoryResources>): CheckResult => {
    const { requests, limits } = (subject as ScopeSubject<MemoryResources>).data!;
    const requestBytes = parseMemoryBytes(requests.memory);
    const limitBytes = parseMemoryBytes(limits.memory);
    const maximumLimitBytes = requestBytes.multipliedBy(1.5);
    return limitBytes.isLessThanOrEqualTo(maximumLimitBytes)
      ? pass()
      : violation('Memory limit must not exceed 1.5 times the memory request.');
  };
}
