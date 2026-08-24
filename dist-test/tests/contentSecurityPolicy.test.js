"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = __importDefault(require("node:test"));
const contentSecurityPolicy_1 = require("../shared/contentSecurityPolicy");
const productionIndex = (0, node_fs_1.readFileSync)(node_path_1.default.resolve(process.cwd(), 'index.html'), 'utf8');
const viteConfig = (0, node_fs_1.readFileSync)(node_path_1.default.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
(0, node_test_1.default)('production CSP remains strict and does not allow inline styles', () => {
    strict_1.default.ok(productionIndex.includes(contentSecurityPolicy_1.PRODUCTION_CONTENT_SECURITY_POLICY));
    strict_1.default.equal(contentSecurityPolicy_1.PRODUCTION_CONTENT_SECURITY_POLICY.includes("'unsafe-inline'"), false);
});
(0, node_test_1.default)('development CSP allows only the inline styles and IPv4 endpoints required by Vite', () => {
    const developmentIndex = (0, contentSecurityPolicy_1.applyDevelopmentContentSecurityPolicy)(productionIndex);
    strict_1.default.ok(developmentIndex.includes(contentSecurityPolicy_1.DEVELOPMENT_CONTENT_SECURITY_POLICY));
    strict_1.default.equal(developmentIndex.includes(contentSecurityPolicy_1.PRODUCTION_CONTENT_SECURITY_POLICY), false);
    strict_1.default.ok(contentSecurityPolicy_1.DEVELOPMENT_CONTENT_SECURITY_POLICY.includes("style-src 'self' 'unsafe-inline'"));
    strict_1.default.ok(contentSecurityPolicy_1.DEVELOPMENT_CONTENT_SECURITY_POLICY.includes('ws://127.0.0.1:*'));
    strict_1.default.ok(contentSecurityPolicy_1.DEVELOPMENT_CONTENT_SECURITY_POLICY.includes('http://127.0.0.1:*'));
    strict_1.default.ok(viteConfig.includes(contentSecurityPolicy_1.DEVELOPMENT_CONTENT_SECURITY_POLICY));
});
