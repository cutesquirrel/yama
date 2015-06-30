var _ = require('underscore'),
    async = require('async'),
    helpers = module.exports,
    globals = {};

helpers.setGlobals = function(opts) {
    globals = opts;
};

helpers.parseJSON = function(object) {
    var set = function(context, variable, rest, value) {
        if (!_.has(context, variable)) {
            context[variable] = {};
        }
        if (rest.length > 0) {
            set(context[variable], _.first(rest), _.rest(rest), value);
        } else {
            context[variable] = value;
        }
    }
    for (var i in object) {
        if (i.indexOf('[') != -1) {
            var parts = i.replace(/\]/gi, '').replace(/\[/gi, '.').split('.');
            set(object, _.first(parts), _.rest(parts), object[i]);
            delete object[i];
        }
    }
}

helpers.sha1 = function(string) {
    var crypto = require('crypto');
    var shasum = crypto.createHash('sha1').update(string);
    return shasum.digest('hex');
}

helpers.capitalizeFirstLetter = function(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

helpers.updateFromObject = function(doc, obj) {
    for (var field in obj) {
        // Avoid empty password.
        if (field == 'password') {
            if (obj[field] != "") doc[field] = obj[field];
        } else {
            doc[field] = obj[field];
        }
    }
}

helpers.getType = function(obj) {
    return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase();
}

helpers.prepareDocToDisplay = function(doc, metas) {
    // we need to cast to JSON.
    // but we want to keep id information (virtual getter).
    var id = doc.id;
    doc = doc.toJSON();
    doc.id = id;
    for (var f in doc) {
        if (metas.fields[f] && typeof(metas.fields[f].to_string) === 'function') {
            doc[f] = metas.fields[f].to_string(doc[f]);
        }
    }

    return doc;
};

//
// Prepare form fields.
//
// - type : view|filters|edit.
// - meta : YAMA init options.
// - doc : ??? is never used.
// - cb : callback : `function(err){}`
//
helpers.processEditFields = function(type, meta, doc, cb) {
    var f, fieldsRef = [],
        fieldsNeedingValues = [],
        fieldsWithCustomValues = [],
        somethingToDo = false;


    // union of edit and list, because list has now filters form as well.
    var allFields = _.union(meta.edit, meta.list);

    _.each(allFields, function(f) {
        if (!meta.fields[f]) {
            console.error('yama.js: [ERROR] field "', f, '" must be defined in settings.');
            // breaks the current iteration.
            return;
        }

        // Get values from related collection.
        if (meta.fields[f].widget === 'ref' || meta.fields[f].ref) {
            somethingToDo = true;
            fieldsRef.push(f);
        }
        // Get values from a custom function.
        else if (typeof(meta.fields[f].values) === 'function') {
            somethingToDo = true;
            fieldsNeedingValues.push(f);
        }
        // Get values from a custom array.
        else if (_.isArray(meta.fields[f].values)) {
            somethingToDo = true;
            fieldsWithCustomValues.push(f);
        }
    });


    if (!somethingToDo) {
        return cb(null);
    }


    // ------------------------
    // Processing fields which use `select` wdiget.
    // needing values found in a related collection, using the `ref` setting.
    // ------------------------
    var fieldProcesses = [],
        field;

    for (f in fieldsRef) {
        field = meta.fields[fieldsRef[f]];

        // the "ref" fields needs model to get values from the other collection.
        fieldProcesses.push({
            field: field,
            model: globals.mongoose.model(field.ref)
        });
    }

    for (f in fieldsNeedingValues) {
        field = meta.fields[fieldsNeedingValues[f]];
        var valuesFunc = meta.fields[fieldsNeedingValues[f]].values;

        // the fields using a custom function to get the values.
        fieldProcesses.push({
            field: field,
            get_values: valuesFunc
        });
    }

    // Values from an array => we only add empty_value if needed.
    for (f in fieldsWithCustomValues) {
        field = meta.fields[fieldsWithCustomValues[f]];

        // if the empty value haven't been already added...
        if (!field.empty_value_already_added) {
            prependEmptyValue(type, field);
        }
    }


    async.eachLimit(fieldProcesses, 20, function(item, done) {
        // The values comes from a model
        // Here the model is a mongoose model (see above).
        if (item.model) {
            // Gets all value of a "select"/"ref" field.
            // For each values :
            // - value = _id
            // - label = get via "display" field.
            item.model.find({}, item.field.display, {
                sort: item.field.display
            }, function(err, results) {
                if (err) return done(err);

                item.field.values = results.map(function(e) {
                    return {
                        display: e[item.field.display] + '',
                        value: e.id + ''
                    };
                });

                if (!item.field.values)
                    item.field.values = [];

                prependEmptyValue(type, item.field);


                done(null);
            });
        }
        // The values comes from a custom function defined in a ‘values‘ attribute.
        else if (item.get_values) {

            item.get_values(item.field, function(err, values) {
                if (err) return done(err);

                // here, we replace the "values" function by the real values.
                item.field.values = values;

                prependEmptyValue(type, item.field);

                done(null);
            });
        }
    }, function(err) {
        if (err) return cb(err);

        // called when all done() have been called.
        cb(null);
    });

};

// Preprend the empty value if necessary.
function prependEmptyValue(type, field) {
    if (field.empty_value) {
        var onlyForFilter = field.empty_value_only_for_filter;

        // On filter form, we always add the `empty_value`.
        // On edit form, we add the `empty_value` only if `empty_value_only_for_filter` is not specified or is `false`.
        if (type === 'filters' || (type !== 'filters' && !onlyForFilter)) {
            field.values.unshift(field.empty_value);
            field.empty_value_already_added = true;
        }
    }
}

//
// Process fiels before save.
//
// meta   : all fields and YAMA settings.
// req    : HTTP request.
// values : values from query or body (repectively filters or saving).
// cb     : callback called after this function terminates his job.
//
helpers.processFormFields = function(meta, req, values, cb) {
    var f, metaField, Model, fieldName,
        //query = {},
        fieldProcesses = [],
        count = 0;

    for (f in meta.edit) {
        fieldName = meta.edit[f];

        if (meta.fields[fieldName].widget == 'password')
            continue;

        // if "ref with mongoose's populate" field or "select from model" field
        if (values[fieldName] === '' || meta.fields[fieldName].widget === 'ref' || meta.fields[fieldName].ref || meta.fields[fieldName].before_save) {
            fieldProcesses.push(meta.edit[f]);
            count++;
        }
    }


    if (!count) {
        return cb();
    }

    async.eachLimit(fieldProcesses, 20, function(fieldName, done) {
            metaField = meta.fields[fieldName];

            //console.log('######## fieldName=', fieldName, 'metaField=', metaField);

            // if `before_save` middleware is defined in settings,
            // it takes the precedence.
            if (metaField.before_save && typeof(metaField.before_save) === 'function') {
                if (metaField.model)
                    Model = globals.mongoose.model(metaField.model);
                else if (metaField.ref)
                    Model = globals.mongoose.model(metaField.ref);

                metaField.before_save(fieldName, req, Model, function(err, fname, val) {
                    count--;

                    if (err) {
                        console.log('helpers.processFormFields: Error in before_save preprocess function of field %s', fieldName, ', values:', val, ', error:', err);
                        return done(err);
                    }

                    return done();
                });
            }
            // If field is empty.
            else if (values[fieldName] === '') {
                // important to keep the field but
                // null is better than '', for an array field for example, '' is invalid.
                // null is more generic.
                values[fieldName] = null;

                return done();
            }
            // If field doesn't exist.
            else if (!values[fieldName]) {
                values[fieldName] = [];

                return done();
            }
        },
        // Last callback, called when all iterator functions have finished or if an error occured.
        function catchAll(err) {
            return cb(err);
        }
    );
};

//
// Process fiels before using them as filters in the list's query.
//
// queryFilters : the current request query (all sent filters).
// meta         : all fields and YAMA settings.
//
helpers.processFilters = function(queryFilters, meta) {

    var filters = {};

    delete filters.page;
    delete filters.perpage;

    // Epurates not wanted filters
    _.each(meta.filters, function(f) {
        if (queryFilters.hasOwnProperty(f)) {
            if (queryFilters[f] !== null && queryFilters[f].length !== 0 && queryFilters[f] !== false && queryFilters[f] !== 'false') {
                filters[f] = queryFilters[f];

                // Preprocess filter if needed.
                if (meta.fields[f].preprocess_filter && typeof(meta.fields[f].preprocess_filter) === 'function') {
                    meta.fields[f].preprocess_filter(f, filters);
                }
            }
        }
    });


    // Merging default criteria with filters.
    // Default ones take precedence, for security reason.
    filters = _.extend(filters, meta.criteria);

    return filters;
};

//
// Get embedded field of a JSON, with dot notation.
// Parameters :
//   - obj : the JSON object.
//   - str : field to get, in a "dot notation" format.
//
// see http://stackoverflow.com/questions/10934664/convert-string-in-dot-notation-to-get-the-object-reference
//
// ````
// var obj = { a: { b: 1, c : { d : 3, e : 4}, f: 5 } }
// str = 'a.c.d'
// ref(obj, str) // 3
// ````
//
helpers.ref = function(obj, str) {
    return str.split(".").reduce(function(o, x) {
        return o[x];
    }, obj);
};

// Generates populate string to give to the `populate()` function of mongoose.
helpers.getPopulateString = function(listOfFields, meta, schema) {
    var fields = meta.fields;

    var populate = '';
    for (var i in listOfFields) {
        var field_name = listOfFields[i];

        // If the schema of the field use "ref", it has to be populated.
        if (fields[field_name] && fields[field_name].ref) {
            var fieldSchema = schema.path(field_name);
            // if a "ref" option is defined in the schema for this field.
            if (fieldSchema && fieldSchema.options && fieldSchema.options.ref) {
                populate += field_name + ' ';
            }
        }
    }
    return populate.substring(0, populate.length - 1);
};