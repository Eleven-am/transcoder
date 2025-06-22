#!/usr/bin/env node

/*
 * @eleven-am/transcoder
 * Copyright (C) 2025 Roy OSSAI
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const GPL_HEADER = `/*
 * @eleven-am/transcoder
 * Copyright (C) 2025 Roy OSSAI
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

`;

// Find all TypeScript files in src directory
const files = glob.sync('src/**/*.ts', { 
    ignore: ['**/*.d.ts', '**/__tests__/**', '**/node_modules/**'] 
});

let filesModified = 0;
let filesSkipped = 0;

files.forEach(file => {
    try {
        const content = fs.readFileSync(file, 'utf8');
        
        // Check if file already has a GPL header
        if (content.includes('GNU General Public License')) {
            console.log(`✓ ${file} - already has GPL header`);
            filesSkipped++;
            return;
        }
        
        // Add header to the beginning of the file
        const newContent = GPL_HEADER + content;
        fs.writeFileSync(file, newContent, 'utf8');
        console.log(`✓ ${file} - GPL header added`);
        filesModified++;
    } catch (error) {
        console.error(`✗ ${file} - Error: ${error.message}`);
    }
});

console.log(`\nSummary:`);
console.log(`- Files checked: ${files.length}`);
console.log(`- Headers added: ${filesModified}`);
console.log(`- Files skipped: ${filesSkipped}`);

// Exit with success
process.exit(0);