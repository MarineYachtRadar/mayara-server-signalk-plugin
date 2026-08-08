import { Type, type Static } from 'typebox';
export declare const ConfigSchema: Type.TObject<{
    managedContainer: Type.TBoolean;
    mayaraVersion: Type.TString;
    mayaraArgs: Type.TArray<Type.TString>;
    requestSignalkToken: Type.TBoolean;
    host: Type.TString;
    port: Type.TNumber;
    secure: Type.TBoolean;
    discoveryPollInterval: Type.TNumber;
    reconnectInterval: Type.TNumber;
}>;
export type Config = Static<typeof ConfigSchema>;
export declare const SCHEMA_DEFAULTS: Config;
//# sourceMappingURL=schema.d.ts.map