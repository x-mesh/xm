#!/usr/bin/env node
// Test stub that self-terminates with SIGKILL before producing any output — exercises
// the adapter surfacing the killing SIGNAL in the exit label (`exit null (SIGKILL)`),
// the real-world "kiro exit null" case where a model dies by signal with empty stderr.
process.kill(process.pid, 'SIGKILL');
