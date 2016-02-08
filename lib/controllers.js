var _ = require('underscore');
var fs = require('fs');

var helpers = require('./helpers'),
    controllers = module.exports,
    // globals contains admin.init() options.
    globals = {};

//
// Maps helpers to the templates.
//
var addHelpers = function(req, res) {
    res.locals.capitalizeFirstLetter = helpers.capitalizeFirstLetter;
    res.locals.staticUrl = '/public' + globals.url;
    res.locals.custom_css = globals.custom_css;
    res.locals.custom_js = globals.custom_js;
    res.locals.base = globals.url;
    res.locals.app_url = globals.app_url;

    var menu = [];
    _.each(globals.info, function(fieldInfos, field) {
        console.log('field=', field, 'fieldInfos:', fieldInfos.label);
        var label = fieldInfos.label ? fieldInfos.label : field;
        label = helpers.capitalizeFirstLetter(label);

        menu.push({
            field: field,
            label: label
        });
    });
    //res.locals.menu = globals.paths;
    menu = _.sortBy(menu, 'label')
    res.locals.menu = menu;

    if (req.flash) {
        res.locals.flash = req.flash();
    }

    res.locals.mapData = function(object, ref, token) {
        if (ref && ref.indexOf('.') !== -1) {
            var parts = ref.split(token);
            var get = function(context, variable, rest) {
                if (!context) {
                    return "";
                }
                if (context || context[variable]) {
                    if (rest.length > 0) {
                        return get(context[variable], _.first(rest), _.rest(rest)) || "";
                    } else {
                        var result = context[variable];
                        return (_.isFunction(result) ? result.call(null) : result) || "";
                    }
                } else {
                    return "";
                }
            };
            object[ref] = get(object, _.first(parts), _.rest(parts));
        }
        return "";
    };
    res.locals.mapName = function(ref, token) {
        if (ref.indexOf('.') !== -1) {
            var parts = ref.split('.');
            var name = parts[0];
            for (var i = 1; i < parts.length; i++) {
                name += '[' + parts[i] + ']';
            }
            return name;
        }
        return ref;
    };
    res.locals.isType = function(param, typeString) {
        return typeof(param) === typeString;
    };
    res.locals.string = function(param) {
        return param.toString();
    };
    res.locals.log = function(input) {
        console.log('INPUT:', input);
        return '';
    };
    res.locals.exists = function(value, values) {
        if (typeof value === typeof values) {
            return value === values;
        } else {
            if (values instanceof Array) {
                return _.find(values, function(item) {
                    if (({}).toString.call(item).match(/\s([a-zA-Z]+)/)[1].toLowerCase() === "object") {
                        return item.id === value;
                    } else {
                        return item === value;
                    }
                });
            } else {
                if (value === values.id) {
                    return value === values.id;
                } else {
                    return value === values.toString();
                }
            }
        }
    };
    res.locals.decrease = function(value) {
        return value - 1;
    };
    res.locals.increase = function(value) {
        return value + 1;
    };
    res.locals.request = req;
    res.locals.getSelectedValue = function(doc, f, fields) {
        //console.log(fields[f], f, doc);

        if (fields[f].value_field) {
            return doc[f] ? doc[f][fields[f].value_field] : null;
        } else {
            return doc[f];
        }
    };
};

var renderTemplate = function(filename, args, res) {
    var swig = require('swig');
    var filesystem_loader = require('./swig_fs_loader');

    for (var i in res.locals) {
        args[i] = res.locals[i];
    }
    swig.setDefaults({
        cache: false,
        loader: filesystem_loader(globals.templates)
    });
    var template = null;

    template = swig.compileFile(filename + '.html', {
        resolveFrom: __dirname + '/../templates/fakefile'
    });

    return res.send(template(args));
};

controllers.setGlobals = function(opts) {
    globals = opts;
    helpers.setGlobals(globals);
};

//
// Index/login
//
controllers.index = function(req, res) {
    addHelpers(req, res);
    renderTemplate('index', {}, res);
};

//
// List the items (list & filters).
//
controllers.list = function(req, res) {

    addHelpers(req, res);
    //if (req.cookies[globals.secret]) {
    if (req.user) {
        var p = req.params.path,
            // YAMA field settings
            meta = globals.info[p],
            Model = globals.mongoose.model(meta.model);


        var page = (req.query.page || 1) - 1;
        var perPage = req.query.perpage || meta.per_page || 30;
        var options = {
            per_page: perPage,
            page: page,
            meta: meta
        };

        _.each(meta.fields, function(f, key) {
            if (!f.header) {
                f.header = key;
            }
        });


        // -----------
        // filters handling
        if (meta.filters) {
            helpers.setGlobals(globals);

            // preparing form fields
            //console.log('processEditFields');
            helpers.processEditFields('filters', meta, null, function() {
                //console.log('=> processEditFields OK');
            });
        }
        // -----------

        //console.log('list');
        options.criteria = helpers.processFilters(req.query, meta);

        options.sort = {};
        if (req.query.sort_by) {
            options.sort[req.query.sort_by] = parseInt(req.query.order);
        }
        // Default sorting.
        else {
            options.sort = meta.order || meta.sort || {};
        }


        //        console.log('List : criteria =', options.criteria, ', sort =', options.sort);


        Model.list(options, function(err, results) {
            if (err) {
                console.error('yama controllers.list', err);
                req.flash('error', err.message);
                return res.redirect('back');
            }

            // Use to_string functions if exist to transform displayed values.
            results.forEach(function(doc, i) {
                results[i] = helpers.prepareDocToDisplay(doc, meta);
            });

            //console.log('=> list OK');
            //console.log(results);

            Model.count(options.criteria).exec(function(err, count) {
                var pages = Math.ceil(count / perPage);
                var pager_pages = Array(pages);

                renderTemplate('list', {
                    title: helpers.capitalizeFirstLetter(meta.label),
                    meta: meta,
                    list: meta.list || [],
                    filters: meta.filters || [],
                    fields: meta.fields || [],
                    data: results,
                    query: req.query,
                    order: options.order,
                    path: p,
                    page: page + 1,
                    perPage: perPage,
                    pages: pages,
                    pager_pages: pager_pages
                }, res);
            });
        });
    } else {
        res.redirect(globals.url);
    }
};

//
// Save an item.
//
controllers.save = function(req, res) {
    addHelpers(req, res);
    if (req.user) {
        helpers.setGlobals(globals);
        var id = req.params.id,
            p = req.params.path,
            Model = globals.mongoose.model(globals.info[p].model);


        Model.findOne({
            _id: id
        }, function(err, doc) {
            if (err) {
                console.error('yama controllers.save', err);
                req.flash('error', err.message);
                return res.redirect('back');
            }

            //console.log('save: processFormFields called', 'BEFORE SAVE, req.body=', req.body);

            helpers.processFormFields(globals.info[p], req, req.body, function(err) {
                if (err) {
                    console.error('controllers.save: processFormFields:', err);
                    if (req.flash) req.flash('error', err.message);
                    return res.redirect('back');
                }

                //console.log('save: processFormFields OK', 'BEFORE SAVE, req.body=', req.body);


                if (!id) {
                    doc = new Model();
                    helpers.updateFromObject(doc, req.body);
                    doc.password = '123change';
                } else {
                    helpers.parseJSON(req.body);
                    helpers.updateFromObject(doc, req.body);
                }

                //console.log('BEFORE SAVE doc=', doc, 'id=', id, 'req.params=', req.params);

                doc.save(function(err, result) {
                    if (err) {
                        console.error('yama controllers.save', err);
                        req.flash('error', err.message);
                        return res.redirect('back');
                    }

                    //console.log('AFTER SAVE, err=', err, ', doc=', result, ',res=', res);

                    if (req.flash) req.flash('info', (!id) ? 'Item successfully created.' : 'Item successfully updated.');

                    return res.redirect(globals.url + '/' + p);
                });
            });
        });
    } else {
        res.redirect(globals.url);
    }
};

//
// View an item without edit it.
//
controllers.view = function(req, res) {
    addHelpers(req, res);
    if (req.user) {
        helpers.setGlobals(globals);
        var p = req.params.path,
            id = req.params.id,
            meta = globals.info[p],
            Model = globals.mongoose.model(meta.model);

        var options = {
            meta: meta
        };

        _.each(meta.fields, function(f, key) {
            if (!f.header) {
                f.header = key;
            }
        });

        Model.details(id, options, function(err, doc) {
            if (err) return res.redirect('404');

            doc = helpers.prepareDocToDisplay(doc, meta);

            helpers.processEditFields('view', meta, doc, function() {
                renderTemplate('view', {
                    meta: meta,
                    doc: doc,
                    path: p,
                    edit: meta.edit,
                    fields: meta.fields
                }, res);
            });
        });
    } else {
        res.redirect('/admin');
    }
};

//
// Edit form loading.
//
controllers.edit = function(req, res) {
    addHelpers(req, res);
    if (req.user) {
        var p = req.params.path,
            id = req.params.id,
            meta = globals.info[p],
            Model = globals.mongoose.models[meta.model];

        var options = {
            meta: meta
        };

        _.each(meta.fields, function(f, key) {
            if (!f.header) {
                f.header = key;
            }
        });

        // "details" called, to populate fields if necessary,
        // for readonly fields, to get corresponding label of a value.
        Model.details(id, options, function(err, doc) {

            //console.log(doc);
            if (err) return renderTemplate('500', {
                error: err
            }, res);
            if (!doc) {
                doc = new Model({});
                var schema = Model.schema.tree;
                //var fields = [];
                for (var schemaAttr in schema) {
                    if (doc[schemaAttr] === undefined && schemaAttr !== '__v') {
                        doc[schemaAttr] = '';
                    }
                }
            }

            helpers.processEditFields('edit', meta, doc, function() {
                var docObject = JSON.parse(JSON.stringify(doc));


                docObject.isNew = doc.isNew;

                //console.log('docObject: ', docObject);
                // console.log('meta:', meta);

                renderTemplate('edit', {
                    meta: meta,
                    doc: docObject,
                    path: p,
                    edit: meta.edit,
                    fields: meta.fields
                }, res);
            });
        });
    } else {
        res.redirect('/admin');
    }
};

//
// Delete an item.
//
controllers.del = function(req, res) {
    addHelpers(req, res);
    if (req.user) {
        var id = req.params.id,
            p = req.params.path,
            Model = globals.mongoose.model(globals.info[p].model);


        Model.findById(id).exec(function(err, model) {
            if (err) {
                if (req.flash) req.flash('error', err.message);
                console.error('YAMA ERROR, controllers.del:', err);
                return res.redirect('back');
            }

            var destroy = typeof(globals.info[p].destroy) === 'function' ? globals.info[p].destroy(req) : globals.info[p].destroy;
            if (destroy === undefined) destroy = false;

            if (destroy) {
                model.remove(function(err) {
                    if (err) {
                        if (req.flash) req.flash('error', err.message);
                        console.error('YAMA ERROR, controllers.del:', err);
                        return res.redirect('back');
                    }

                    if (req.flash) req.flash('info', 'Item successfully removed.');

                    return res.redirect(globals.url + '/' + p);
                });
            } else {

                // update a boolean field (status of the user)
                if (globals.info[p].active_field_name)
                    model[globals.info[p].active_field_name] = false;
                else
                    model.active = false;

                model.save(function(err) {
                    if (err) {
                        if (req.flash) req.flash('error', err.message);
                        console.error('YAMA ERROR, controllers.del:', err);
                        return res.redirect('back');
                    }

                    if (req.flash) req.flash('info', 'Item successfully disabled.');
                    return res.redirect(globals.url + '/' + p);
                });
            }
        });
    } else {
        console.error('YAMA ERROR: user not found in the request.');
        res.redirect(globals.url);
    }
};



//
// Login screen if default authentication is used.
//
controllers.login = function(req, res) {
    addHelpers(req, res);
    if (req.method.toLowerCase() === "post") {
        var models = require('./models.js')(globals.mongoose);
        var Admin = models.Admin;
        Admin.findOne({
            email: req.body.email,
            password: helpers.sha1(req.body.password),
            active: true
        }, function(err, model) {
            if (err) renderTemplate('500', {}, res);
            if (model == null) {
                renderTemplate('login', {
                    error: 'Access denied'
                }, res);
            } else {
                res.cookie(globals.secret, model._id, {
                    maxAge: 315532800000
                });
                renderTemplate('index', {}, res);
            }
        });
    } else {
        if (req.user) {
            renderTemplate('index', {}, res);
        } else {
            delete req.cookies[globals.secret];
            renderTemplate('login', {}, res);
        }
    }
};

//
// Logout action if default authentication is used.
//
controllers.logout = function(req, res) {
    addHelpers(req, res);
    res.clearCookie(globals.secret);
    res.redirect(globals.url);
};