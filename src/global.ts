import * as path from "path";

import * as bslglobals from "./features/bslGlobals";
import * as oscriptStdLib from "./features/oscriptStdLib";

let loki = require("lokijs");
let Parser = require("onec-syntaxparser");
let FileQueue = require("filequeue");
let fq = new FileQueue(500);

export class Global {
    cache: any;
    db: any;
    dbcalls: Map<string, Array<{}>>;
    globalfunctions: any;
    globalvariables: any;
    keywords: any;
    systemEnum: any;
    classes: any;
    toreplaced: any;
    methodForDescription: any = undefined;
    syntaxFilled: string = "";
    hoverTrue: boolean = true;
    private cacheUpdates: boolean;

    getCacheLocal(filename: string, word: string, source, update: boolean = false, allToEnd: boolean = true, fromFirst: boolean = true) {
        let suffix = allToEnd ? "" : "$";
        let prefix = fromFirst ? "^" : "";
        let querystring = { "name": { "$regex": new RegExp(prefix + word + suffix, "i") } };
        let entries = new Parser().parse(source).getMethodsTable().find(querystring);
        return entries;
    }

    getRefsLocal(filename: string, source: string) {
        let parsesModule = new Parser().parse(source);
        let entries = parsesModule.getMethodsTable().find();
        let count = 0;
        let collection = this.cache.addCollection(filename);
        this.updateReferenceCallsOld(collection, parsesModule.context.CallsPosition, "GlobalModuleText", filename);
        for (let y = 0; y < entries.length; ++y) {
            let item = entries[y];
            this.updateReferenceCallsOld(collection, item._method.CallsPosition, item, filename);
        }
        return collection;
    }

    getReplaceMetadata() {
        return {
            "AccountingRegisters": "РегистрыБухгалтерии",
            "AccumulationRegisters": "РегистрыНакопления",
            "BusinessProcesses": "БизнесПроцессы",
            "CalculationRegisters": "РегистрыРасчета",
            "ChartsOfAccounts": "ПланыСчетов",
            "ChartsOfCalculationTypes": "ПланыВидовРасчета",
            "ChartsOfCharacteristicTypes": "ПланыВидовХарактеристик",
            "Constants": "Константы",
            "Catalogs": "Справочники",
            "DataProcessors": "Обработки",
            "DocumentJournals": "ЖурналыДокументов",
            "Documents": "Документы",
            "Enums": "Перечисления",
            "ExchangePlans": "ПланыОбмена",
            "InformationRegisters": "РегистрыСведений",
            "Reports": "Отчеты",
            "SettingsStorages": "ХранилищаНастроек",
            "Tasks": "Задачи"
        };
    }

    getModuleForPath(fullpath: string, rootPath: string): any {
        let splitsymbol = "/";
        let moduleArray: Array<string> = fullpath.substr(rootPath.length + (rootPath.slice(-1) === "\\" ? 0 : 1)).split(splitsymbol);
        let moduleStr = "";
        let hierarchy = moduleArray.length;
        if (hierarchy > 3) {
            if (moduleArray[hierarchy - 4].startsWith("CommonModules")) {
                moduleStr = moduleArray[hierarchy - 3];
            } else if (hierarchy > 3 && this.toreplaced[moduleArray[hierarchy - 4]] !== undefined) {
                moduleStr = this.toreplaced[moduleArray[hierarchy - 4]] + "." + moduleArray[hierarchy - 3];
            }
        }
        return moduleStr;
    }

    addtocachefiles(files: Array<string>, rootPath: string): any {
        let filesLength = files.length;
        let substrIndex = (process.platform === "win32") ? 8 : 7;
        for (let i = 0; i < filesLength; ++i) {
            let fullpath = files[i].toString();
            fullpath = decodeURIComponent(fullpath);
            if (fullpath.startsWith("file:")) {
                fullpath = fullpath.substr(substrIndex);
            }
            fq.readFile(fullpath, { encoding: "utf8" }, (err, source) => {
                if (err) {
                    throw err;
                }
                let moduleStr = fullpath.endsWith(".bsl") ? this.getModuleForPath(fullpath, rootPath) : "";
                source = source.replace(/\r\n?/g, "\n");
                let parsesModule = new Parser().parse(source);
                source = null;
                let entries = parsesModule.getMethodsTable().find();
                if (i % 100 === 0) {
                    this.postMessage("Обновляем кэш файла № " + i + " из " + filesLength, 2000);
                }
                if (parsesModule.context.CallsPosition.length > 0) {
                    this.updateReferenceCalls(parsesModule.context.CallsPosition, "GlobalModuleText", fullpath);
                }
                parsesModule = null;
                for (let y = 0; y < entries.length; ++y) {
                    let item = entries[y];
                    let method = { name: item.name, endline: item.endline, context: item.context, isproc: item.isproc };
                    if (item._method.CallsPosition.length > 0) {
                        this.updateReferenceCalls(item._method.CallsPosition, method, fullpath);
                    }
                    let _method = { Params: item._method.Params, IsExport: item._method.IsExport };
                    let newItem: MethodValue = {
                        "name": String(item.name),
                        "isproc": Boolean(item.isproc),
                        "line": item.line,
                        "endline": item.endline,
                        "context": item.context,
                        "_method": _method,
                        "filename": fullpath,
                        "module": moduleStr,
                        "description": item.description
                    };
                    this.db.insert(newItem);
                }
                if (i === filesLength - 1) {
                    this.postMessage("Кэш обновлен");
                    this.cacheUpdates = true;
                }
            });
        }
    }

    updateCache(): any {
        let configuration = this.getConfiguration("language-1c-bsl");
        let basePath: string = String(this.getConfigurationKey(configuration, "rootPath"));
        let rootPath = this.getRootPath();
        if (rootPath) {
            console.log("update cache");
            this.postMessage("Запущено заполнение кеша", 3000);
            rootPath = path.join(rootPath, basePath);
            if (this.cache.getCollection ("ValueTable")) {
                this.cache.removeCollection("ValueTable");
            }
            this.db = this.cache.addCollection("ValueTable");
            this.dbcalls = new Map();
            let searchPattern = basePath !== "" ? basePath.substr(2) + "/**" : "**/*.{bsl,os}";
            this.findFilesForCache(searchPattern, rootPath);
        }
    };

    customUpdateCache(source: string, filename: string) {
        if (!this.cacheUpdates) {
            return;
        }
        let configuration = this.getConfiguration("language-1c-bsl");
        let basePath: string = String(this.getConfigurationKey(configuration, "rootPath"));
        let rootPath = path.join(this.getRootPath(), basePath);
        let fullpath = filename.replace(/\\/g, "/");
        let methodArray = this.db.find({ "filename": { "$eq": fullpath } });
        for (let index = 0; index < methodArray.length; index++) {
            let element = methodArray[index];
            this.db.remove(element["$loki"]);
        }
        let parsesModule = new Parser().parse(source);
        let moduleStr = this.getModuleForPath(fullpath, rootPath);
        let entries = parsesModule.getMethodsTable().find();
        for (let index = 0; index < this.cache.getCollection(filename).data.length; index++) {
            let value = this.cache.getCollection(filename).data[index];
            if (value.call.startsWith(".")) {
                continue;
            }
            if (value.call.indexOf(".") === -1) {
                continue;
            }
            let arrCalls = this.dbcalls.get(value.call);
            if (arrCalls) {
                for (let k = arrCalls.length - 1; k >= 0; --k) {
                    let it = arrCalls[k];
                    if (it["filename"] === fullpath) {
                        arrCalls.splice(k, 1);
                    }
                }
            }
        }
        this.cache.removeCollection(filename);
        this.getRefsLocal(filename, source);
        this.updateReferenceCalls(parsesModule.context.CallsPosition, "GlobalModuleText", fullpath);
        for (let y = 0; y < entries.length; ++y) {
            let item = entries[y];
            this.updateReferenceCalls(item._method.CallsPosition, item, fullpath);
            let _method = { Params: item._method.Params, IsExport: item._method.IsExport };
            let newItem = {
                "name": String(item.name),
                "isproc": Boolean(item.isproc),
                "line": item.line,
                "endline": item.endline,
                "context": item.context,
                "_method": _method,
                "filename": fullpath,
                "module": moduleStr,
                "description": item.description
            };
            this.db.insert(newItem);
        }
    };

    queryref(word: string, collection: any, local: boolean = false): any {
        if (!collection) {
            return new Array();
        }
        let prefix = local ? "" : ".";
        let querystring = { "call": { "$regex": new RegExp(prefix + word + "$", "i") } };
        let search = collection.chain().find(querystring).simplesort("name").data();
        return search;
    }

    private updateReferenceCalls(calls: Array<any>, method: any, file: string): any {
        for (let index = 0; index < calls.length; index++) {
            let value = calls[index];
            if (value.call.startsWith(".")) {
                continue;
            }
            if (value.call.indexOf(".") === -1) {
                continue;
            }
            let arrCalls = this.dbcalls.get(value.call);
            if (!arrCalls) {
                this.dbcalls.set(value.call, []);
                arrCalls = this.dbcalls.get(value.call);
            }
            arrCalls.push({ filename: file, call: value.call, line: value.line, character: value.character, name: String(method.name) });
        }
    }

    private updateReferenceCallsOld(collection: any, calls: Array<any>, method: any, file: string): any {
        for (let index = 0; index < calls.length; index++) {
            let value = calls[index];
            if (value.call.startsWith(".")) {
                continue;
            }
            let newItem: MethodValue = {
                "name": String(method.name),
                "filename": file,
                "isproc": Boolean(method.isproc),
                "call": value.call,
                "context": method.context,
                "line": value.line,
                "character": value.character,
                "endline": method.endline
            };
            collection.insert(newItem);
        }
    }

    querydef(module: string, all: boolean = true, lazy: boolean = false): any {
        // Проверяем локальный кэш. 
        // Проверяем глобальный кэш на модули. 
        if (!this.cacheUpdates) {
            return new Array();
        } else {
            let prefix = lazy ? "" : "^";
            let suffix = all ? "" : "$";
            let querystring = { "module": { "$regex": new RegExp(prefix + module + suffix, "i") } };
            let search = this.db.chain().find(querystring).simplesort("name").data();
            return search;
        }
    }

    query(word: string, module: string, all: boolean = true, lazy: boolean = false): any {
        let prefix = lazy ? "" : "^";
        let suffix = all ? "" : "$";
        let querystring = { "name": { "$regex": new RegExp(prefix + word + suffix, "i") } };
        if (module && module.length > 0) {
            querystring["module"] = { "$regex": new RegExp("^" + module + "", "i") };
        }
        let moduleRegexp = new RegExp("^" + module + "$", "i");
        function filterByModule(obj) {
            if (module && module.length > 0) {
                if (moduleRegexp.exec(obj.module) != null) {
                    return true;
                } else {
                    return false;
                }
            }
            return true;
        }
        let search = this.db.chain().find(querystring).where(filterByModule).simplesort("name").data();
        return search;
    }

    GetSignature(entry) {
        let description = entry.description.replace(/\/\//g, "");
        description = description.replace(new RegExp("[ ]+", "g"), " ");
        let retState = (new RegExp("^\\s*(Возвращаемое значение|Return value|Returns):?\\n\\s*([<\\wа-яА-Я\\.>]+)(.|\\n)*", "gm")).exec(description);
        let strRetState = null;
        if (retState) {
            strRetState = retState[2];
            description = description.substr(0, retState.index);
        }
        let paramsString = "(";
        for (let element in entry._method.Params) {
            let nameParam = entry._method.Params[element];
            paramsString = (paramsString === "(" ? paramsString : paramsString + ", ") + nameParam;
            let re = new RegExp("^\\s*(Параметры|Parameters)(.|\\n)*\\n\\s*" + nameParam + "\\s*(-|–)\\s*([<\\wа-яА-Я\\.>]+)", "gm");
            let match: RegExpExecArray = null;
            if ((match = re.exec(description)) !== null) {
                paramsString = paramsString + ": " + match[4];
            }
        }
        paramsString = paramsString + ")";
        if (strRetState) {
            paramsString = paramsString + ": " + strRetState;
        }
        return { description: description, paramsString: paramsString, strRetState: strRetState, fullRetState: (!retState) ? "" : retState[0] };
    }

    GetDocParam(description: string, param) {
        let optional = false;
        let descriptionParam = "";
        let re = new RegExp("(Параметры|Parameters)(.|\\n)*\\n\\s*" + param + "\\s*(-|–)\\s*([<\\wа-яА-Я\\.>]+)\\s*-?\\s*((.|\\n)*)", "g");
        let match: RegExpExecArray = null;
        if ((match = re.exec(description)) !== null) {
            descriptionParam = match[5];
            let cast = (new RegExp("\\n\\s*[<\\wа-яА-Я\\.>]+\\s*(-|–)\\s*", "g")).exec(descriptionParam);
            if (cast) {
                descriptionParam = descriptionParam.substr(0, cast.index);
            }
        }
        let documentationParam = { optional: optional, descriptionParam: descriptionParam };
        return documentationParam;
    }

    redefineMethods(adapter) {
        let methodsList = [
            "postMessage",
            "getConfiguration",
            "getConfigurationKey",
            "getRootPath",
            "fullNameRecursor",
            "findFilesForCache"
        ];
        methodsList.forEach(element => {
            if (adapter.hasOwnProperty(element)) {
                this[element] = adapter[element];
            }
        });
    }

    public postMessage(description: string, interval?: number) {}

    public getConfiguration(section: string) {}

    public getConfigurationKey(configuration, key: string) {}

    public getRootPath(): string {
        return "";
    }

    public fullNameRecursor(word: string, document, range, left: boolean): string {
        return "";
    }

    public findFilesForCache(searchPattern: string, rootPath: string) {}

    constructor(adapter?: any) {
        if (adapter) {
            this.redefineMethods(adapter);
        }
        let configuration = this.getConfiguration("language-1c-bsl");
        let autocompleteLanguage: any = this.getConfigurationKey(configuration, "languageAutocomplete");
        let postfix = (autocompleteLanguage === "en") ? "_en" : "";
        this.toreplaced = this.getReplaceMetadata();
        this.cache = new loki("gtags.json");
        this.cacheUpdates = false;
        this.globalfunctions = {};
        this.globalvariables = {};
        this.systemEnum = {};
        this. classes = {};
        let globalfunctions = bslglobals.globalfunctions();
        let globalvariables = bslglobals.globalvariables();
        this.keywords = bslglobals.keywords()[autocompleteLanguage];
        for (let element in globalfunctions) {
            let new_name = globalfunctions[element]["name" + postfix];
            let new_element = {};
            new_element["name"] = new_name;
            new_element["alias"] = (postfix === "_en") ? globalfunctions[element]["name"] : globalfunctions[element]["name_en"];
            new_element["description"] = globalfunctions[element].description;
            new_element["signature"] = globalfunctions[element].signature;
            new_element["returns"] = globalfunctions[element].returns;
            this.globalfunctions[new_name.toLowerCase()] = new_element;
        }
        for (let element in oscriptStdLib.globalContextOscript()) {
            let segment = oscriptStdLib.globalContextOscript()[element];
            for (let key in segment["methods"]) {
                if (this.globalfunctions[segment["methods"][key]["name" + postfix].toLowerCase()]) {
                    let globMethod = this.globalfunctions[segment["methods"][key]["name" + postfix].toLowerCase()];
                    globMethod["oscript_signature"] = { "default": { "СтрокаПараметров": segment["methods"][key].signature, "Параметры": segment["methods"][key].params } };
                    globMethod["oscript_description"] = segment["methods"][key].description;
                } else {
                    let new_element = {};
                    let new_name = segment["methods"][key]["name" + postfix];
                    new_element["name"] = new_name;
                    new_element["alias"] = (postfix === "_en") ? segment["methods"][key]["name"] : segment["methods"][key]["name_en"];
                    new_element["description"] = undefined;
                    new_element["signature"] = undefined;
                    new_element["returns"] = segment["methods"][key].returns;
                    new_element["oscript_signature"] = { "default": { "СтрокаПараметров": segment["methods"][key].signature, "Параметры": segment["methods"][key].params } };
                    new_element["oscript_description"] = segment["methods"][key].description;
                    this.globalfunctions[new_name.toLowerCase()] = new_element;
                }
            }
        }
        for (let element in globalvariables) {
            let new_name = globalvariables[element]["name" + postfix];
            let new_element = {};
            new_element["name"] = new_name;
            new_element["alias"] = (postfix === "_en") ? globalvariables[element]["name"] : globalvariables[element]["name_en"];
            new_element["description"] = globalvariables[element].description;
            this.globalvariables[new_name.toLowerCase()] = new_element;
        }
        for (let element in oscriptStdLib.globalContextOscript()) {
            let segment = oscriptStdLib.globalContextOscript()[element];
            for (let key in segment["properties"]) {
                if (this.globalvariables[segment["properties"][key]["name" + postfix].toLowerCase()]) {
                    let globVar = this.globalvariables[segment["properties"][key]["name" + postfix].toLowerCase()];
                    globVar["oscript_description"] = segment["properties"][key].description;
                    globVar["oscript_access"] = segment["properties"][key].access;
                } else {
                    let new_element = {};
                    let new_name = segment["properties"][key]["name" + postfix];
                    new_element["name"] = new_name;
                    new_element["alias"] = (postfix === "_en") ? segment["properties"][key]["name"] : segment["properties"][key]["name_en"];
                    new_element["description"] = undefined;
                    new_element["oscript_description"] = segment["properties"][key].description;
                    new_element["oscript_access"] = segment["properties"][key].access;
                    this.globalvariables[new_name.toLowerCase()] = new_element;
                }
            }
        }
        for (let element in bslglobals.systemEnum()) {
            let segment = bslglobals.systemEnum()[element];
            let new_name = segment["name" + postfix];
            let new_element = {};
            new_element["name"] = new_name;
            new_element["alias"] = (postfix === "_en") ? segment["name"] : segment["name_en"];
            new_element["description"] = segment.description;
            for (let key in segment["values"]) {
                let new_name_values = segment["values"][key]["name" + postfix];
                let element_values = {};
                element_values["name"] = new_name;
                element_values["alias"] = (postfix === "_en") ? segment["values"][key]["name"] : segment["values"][key]["name_en"];
                element_values["description"] = segment.description;
                new_element[new_name_values.toLowerCase()] = element_values;
            }
            this.systemEnum[new_name.toLowerCase()] = new_element;
        }
        for (let element in oscriptStdLib.systemEnum()) {
            let segment = oscriptStdLib.systemEnum()[element];
            let new_name = segment["name" + postfix];
            if (this.systemEnum[new_name.toLowerCase()]) {
                let find_enum = this.systemEnum[new_name.toLowerCase()];
                find_enum["oscript_description"] = segment.description;
            } else {
                let new_element = {};
                new_element["name"] = new_name;
                new_element["alias"] = (postfix === "_en") ? segment["name"] : segment["name_en"];
                new_element["description"] = undefined;
                new_element["oscript_description"] = segment.description;
                for (let key in segment["values"]) {
                    let new_name_values = segment["values"][key]["name" + postfix];
                    let element_values = {};
                    element_values["name"] = new_name;
                    element_values["alias"] = (postfix === "_en") ? segment["values"][key]["name"] : segment["values"][key]["name_en"];
                    element_values["description"] = segment.description;
                    new_element[new_name_values.toLowerCase()] = element_values;
                }
            this.systemEnum[new_name.toLowerCase()] = new_element;
            }
        }
        for (let element in bslglobals.classes()) {
            let segment = bslglobals.classes()[element];
            let new_name = segment["name" + postfix];
            let new_element = {};
            new_element["name"] = new_name;
            new_element["alias"] = (postfix === "_en") ? segment["name"] : segment["name_en"];
            new_element["description"] = segment.description;
            new_element["methods"] = (segment["methods"]) ? {} : undefined;
            for (let key in segment["methods"]) {
                let new_name_method = segment["methods"][key]["name" + postfix];
                let new_method = {};
                new_method["name"] = new_name;
                new_method["alias"] = (postfix === "_en") ? segment["methods"][key]["name"] : segment["methods"][key]["name_en"];
                new_method["description"] = segment["methods"][key].description;
                new_element["methods"][new_name_method.toLowerCase()] = new_method;
            }
            new_element["properties"] = (segment["properties"]) ? {} : undefined;
            for (let key in segment["properties"]) {
                let new_name_prop = segment["properties"][key]["name" + postfix];
                let new_prop = {};
                new_prop["name"] = new_name;
                new_prop["alias"] = (postfix === "_en") ? segment["properties"][key]["name"] : segment["properties"][key]["name_en"];
                new_prop["description"] = segment["properties"][key].description;
                new_element["properties"][new_name_prop.toLowerCase()] = new_prop;
            }
            new_element["constructors"] = (segment["constructors"]) ? {} : undefined;
            for (let key in segment["constructors"]) {
                let new_cntr = {};
                new_cntr["signature"] = segment["constructors"][key].signature;
                new_cntr["description"] = segment["constructors"][key].description;
                new_element["constructors"][key.toLowerCase()] = new_cntr;
            }
            this.classes[new_name.toLowerCase()] = new_element;
        }
        for (let element in oscriptStdLib.classesOscript()) {
            let segment = oscriptStdLib.classesOscript()[element];
            let new_name = segment["name" + postfix];
            if (this.classes[new_name.toLowerCase()]) {
                let find_class = this.classes[new_name.toLowerCase()];
                find_class["oscript_description"] = segment.description;
                for (let key in segment["methods"]) {
                    let find_method = segment["methods"][key];
                    let name_method = find_method["name" + postfix];
                    if (!find_method) {
                        find_method = {};
                        find_method["name"] = name_method;
                        find_method["alias"] = (postfix === "_en") ? segment["methods"][key]["name"] : segment["methods"][key]["name_en"];
                        find_method["description"] = undefined;
                        find_method["oscript_description"] = segment["methods"][key]["description"];
                        find_class["methods"][name_method.toLowerCase()] = find_method;
                    } else {
                        find_method["oscript_description"] = segment["methods"][key]["description"];
                    }
                }
                for (let key in segment["properties"]) {
                    let find_prop = segment["properties"][key];
                    let name_prop = find_prop["name" + postfix];
                    if (!find_prop) {
                        find_prop = {};
                        find_prop["name"] = name_prop;
                        find_prop["alias"] = (postfix === "_en") ? segment["properties"][key]["name"] : segment["properties"][key]["name_en"];
                        find_prop["description"] = undefined;
                        find_prop["oscript_description"] = segment["properties"][key]["description"];
                        find_class["properties"][name_prop.toLowerCase()] = find_prop;
                    } else {
                        find_prop["oscript_description"] = segment["properties"][key]["description"];
                    }
                }
                for (let key in segment["constructors"]) {
                    let find_cntr = segment["constructors"][key];
                    if (!find_cntr) {
                        find_cntr = {};
                        find_cntr["description"] = undefined;
                        find_cntr["oscript_description"] = segment["constructors"][key]["description"];
                        find_class["constructors"][key.toLowerCase()] = find_cntr;
                    } else {
                        find_cntr["oscript_description"] = segment["constructors"][key]["description"];
                    }
                }
            } else {
                let new_element = {};
                new_element["name"] = new_name;
                new_element["alias"] = (postfix === "_en") ? segment["name"] : segment["name_en"];
                new_element["description"] = undefined;
                new_element["oscript_description"] = segment.description;
                new_element["methods"] = (segment["methods"]) ? {} : undefined;
                for (let key in segment["methods"]) {
                    let new_name_method = segment["methods"][key]["name" + postfix];
                    let new_method = {};
                    new_method["name"] = new_name;
                    new_method["alias"] = (postfix === "_en") ? segment["methods"][key]["name"] : segment["methods"][key]["name_en"];
                    new_method["description"] = undefined;
                    new_method["oscript_description"] = segment["methods"][key].description;
                    new_element["methods"][new_name_method.toLowerCase()] = new_method;
                }
                new_element["properties"] = (segment["properties"]) ? {} : undefined;
                for (let key in segment["properties"]) {
                    let new_name_prop = segment["properties"][key]["name" + postfix];
                    let new_prop = {};
                    new_prop["name"] = new_name;
                    new_prop["alias"] = (postfix === "_en") ? segment["properties"][key]["name"] : segment["properties"][key]["name_en"];
                    new_prop["description"] = undefined;
                    new_prop["oscript_description"] = segment["properties"][key].description;
                    new_element["properties"][new_name_prop.toLowerCase()] = new_prop;
                }
                new_element["constructors"] = (segment["constructors"]) ? {} : undefined;
                for (let key in segment["constructors"]) {
                    let new_cntr = {};
                    new_cntr["signature"] = segment["constructors"][key].signature;
                    new_cntr["description"] = undefined;
                    new_cntr["oscript_description"] = segment["constructors"][key].description;
                    new_element["constructors"][key.toLowerCase()] = new_cntr;
                }
                this.classes[new_name.toLowerCase()] = new_element;
            }
        }
    }
}

interface MethodValue {
    // Имя процедуры/функции'
    name: string;
    // Процедура = true, Функция = false
    isproc: boolean;
    // начало
    line: number;
    // конец процедуры
    endline: number;

    filename: string;
    // контекст НаСервере, НаКлиенте, НаСервереБезКонтекста
    context?: string;
    module?: string;
    description?: string;
    call?: string;
    character?: number;
    _method?: {};
}

/// <reference path="node.d.ts" />