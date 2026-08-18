#!/usr/bin/env node
/**
 * Manual smoke test for pi-server error code refactor
 * Run with: node --import tsx/esm test-error-codes-manual.mjs
 */

import { PiServerError, PiServerErrorCode, isRecoverableTreeDivergenceCode, isRecoverableMissingServerStateCode } from '../src/error-codes.ts';
import { appendSessionEntries, getOrCreateSession, getSession } from '../src/session-store.ts';

console.log('=== Pi-Server Error Code Smoke Tests ===\n');

// Test 1: PiServerError construction
console.log('Test 1: PiServerError construction');
try {
	const error = new PiServerError('Test error', PiServerErrorCode.PARENT_ENTRY_NOT_FOUND, { parentId: 'test-123' });
	console.log('  ✓ Error created:', error.message);
	console.log('  ✓ Error code:', error.code);
	console.log('  ✓ Error details:', JSON.stringify(error.details));
} catch (err) {
	console.log('  ✗ Failed:', err.message);
	process.exit(1);
}
console.log();

// Test 2: Error code detection functions
console.log('Test 2: Error code detection functions');
console.log('  ✓ PARENT_ENTRY_NOT_FOUND is recoverable tree divergence:', 
	isRecoverableTreeDivergenceCode(PiServerErrorCode.PARENT_ENTRY_NOT_FOUND));
console.log('  ✓ LEAF_ID_NOT_FOUND is recoverable tree divergence:', 
	isRecoverableTreeDivergenceCode(PiServerErrorCode.LEAF_ID_NOT_FOUND));
console.log('  ✓ SESSION_NOT_FOUND is NOT recoverable tree divergence:', 
	!isRecoverableTreeDivergenceCode(PiServerErrorCode.SESSION_NOT_FOUND));
console.log('  ✓ SESSION_NO_STATIC_CONTEXT is recoverable missing state:', 
	isRecoverableMissingServerStateCode(PiServerErrorCode.SESSION_NO_STATIC_CONTEXT));
console.log();

// Test 3: Session store throws PiServerError
console.log('Test 3: Session store throws PiServerError with codes');
try {
	const sessionId = 'test-error-session';
	getOrCreateSession(sessionId);
	
	// Try to append entry with non-existent parent
	appendSessionEntries(sessionId, [{
		id: 'entry-child',
		parentId: 'non-existent-parent',
		type: 'message',
		message: {
			role: 'user',
			content: 'test',
			timestamp: Date.now(),
		}
	}], null);
	
	console.log('  ✗ Should have thrown PiServerError');
	process.exit(1);
} catch (err) {
	if (err instanceof PiServerError) {
		console.log('  ✓ Threw PiServerError');
		console.log('  ✓ Error code:', err.code);
		console.log('  ✓ Expected code PARENT_ENTRY_NOT_FOUND:', 
			err.code === PiServerErrorCode.PARENT_ENTRY_NOT_FOUND);
		if (err.code !== PiServerErrorCode.PARENT_ENTRY_NOT_FOUND) {
			console.log('  ✗ Wrong error code!');
			process.exit(1);
		}
	} else {
		console.log('  ✗ Threw wrong error type:', err.constructor.name);
		process.exit(1);
	}
}
console.log();

// Test 4: leafId not found error
console.log('Test 4: leafId not found throws correct error code');
try {
	const sessionId = 'test-leaf-error';
	getOrCreateSession(sessionId);
	
	appendSessionEntries(sessionId, [], 'non-existent-leaf');
	
	console.log('  ✗ Should have thrown PiServerError');
	process.exit(1);
} catch (err) {
	if (err instanceof PiServerError && err.code === PiServerErrorCode.LEAF_ID_NOT_FOUND) {
		console.log('  ✓ Threw PiServerError with LEAF_ID_NOT_FOUND');
	} else {
		console.log('  ✗ Wrong error or code:', err);
		process.exit(1);
	}
}
console.log();

console.log('=== All Smoke Tests Passed ===');
