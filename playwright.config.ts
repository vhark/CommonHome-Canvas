import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests',timeout:120000,workers:1,retries:0,reporter:[['list'],['json',{outputFile:process.env.SPIKE_REPORT||'.planning/phases/01-editor-and-responsive-design-proof/evidence/playwright.json'}]],outputDir:'test-results',use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},webServer:{command:'npm run dev:spike',url:'http://127.0.0.1:4173',reuseExistingServer:false},projects:[
{name:'chromium-reference',use:{browserName:'chromium',viewport:{width:1920,height:1080},deviceScaleFactor:1}},
{name:'firefox-reference',use:{browserName:'firefox',viewport:{width:1920,height:1080},deviceScaleFactor:1}},
{name:'webkit-reference',use:{browserName:'webkit',viewport:{width:1920,height:1080},deviceScaleFactor:1}},
{name:'chromium-tablet',use:{browserName:'chromium',viewport:{width:1024,height:768},deviceScaleFactor:2,hasTouch:true}},
{name:'webkit-tablet',use:{browserName:'webkit',viewport:{width:1024,height:768},deviceScaleFactor:2,hasTouch:true}},
// Matches the real iPhone that produced TOUCH-EVIDENCE.md: iOS 26.6.2 reported
// 832x384 CSS px landscape at DPR 3. Every other project is DPR 1 or 2 and at
// least 768 tall, so this viewport sat entirely outside the matrix - which is
// what real hardware is for. WebKit because every iOS browser must use it.
{name:'webkit-phone-landscape',use:{browserName:'webkit',viewport:{width:832,height:384},deviceScaleFactor:3,hasTouch:true}},
{name:'webkit-phone-portrait',use:{browserName:'webkit',viewport:{width:384,height:832},deviceScaleFactor:3,hasTouch:true}}]});
