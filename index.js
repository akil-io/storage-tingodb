const tingo = require('tingodb')({
	nativeObjectID: true
});
const DbClient = tingo.Db;
const assert = require('assert');
const ObjectID = tingo.ObjectID;
const path = require('path');

class CollectionWrapper {
	constructor(db, collection = null, cursor = null) {
		this._db = db;
		this._collection = collection;
		this._cursor = cursor;
	}

	collection(name) {
		return new CollectionWrapper(this._db, this._db.collection(name));
	}

	find(filter) {
		return new CollectionWrapper(this._db, this._collection, this._collection.find(filter));
	}

	findOne(filter) {
		return new Promise((resolve, reject) => {
			this._collection.findOne(filter, (err, result) => {
				if (!err && result) resolve(result); 
				else reject(err);
			});
		});	
	}

	insertOne(data) {
		return new Promise((resolve, reject) => {
			data = Object.keys(data).reduce((a, c) => {
				if (c === '_id') {
					if (data[c]) a[c] = data[c];
				} else a[c] = data[c];
				return a;
			}, {});
			this._collection.insert(data, (err, result) => {
				if (!err && result) resolve({
					result: { n: result.length },
					ops: result
				}); 
				else reject(err);
			});
		});
	}
	updateOne(filter, data) {
		return new Promise((resolve, reject) => {
			this._collection.update(filter, data, (err, result) => {
				if (!err && result) resolve(result); 
				else reject(err);
			});
		});
	}
	deleteOne(filter) {
		return new Promise((resolve, reject) => {
			this._collection.remove(filter, {single:true}, (err, result) => {
				if (!err && result != undefined) resolve({deletedCount:result}); 
				else reject(err);
			});
		});
	}

	countDocuments(filter) {
		return new Promise((resolve, reject) => {
			this._collection.count(filter, (err, result) => {
				if (!err && result !== undefined) resolve(result); 
				else reject(err);
			});
		});
	}
	skip(count) {
		this._cursor.skip(parseInt(count));
		return this;
	}
	limit(count) {
		this._cursor.limit(parseInt(count));
		return this;
	}
	toArray() {
		return new Promise((resolve, reject) => {
			this._cursor.toArray((err, result) => {
				if (!err && result) resolve(result); 
				else reject(err);
			});
		});
	}

	deleteMany(filter) {
		return new Promise((resolve, reject) => {
			this._collection.remove(filter, (err, result) => {
				if (!err && result != undefined) resolve({deletedCount:result}); 
				else reject(err);
			});
		});
	}
};

class TingoDB {
	constructor(settings) {
		this.settings = Object.assign({}, {
			dirName: path.resolve('./'),
      		dbName: "test"
		}, settings);
		this.client = null;
		this.db = null;
	}
	connect() {
		return new Promise((resolve, reject) => {
			this.client = DbClient;
			this.db = new CollectionWrapper(new DbClient(path.resolve(this.settings.dirName), {}));
			resolve(this);
		});
	}
	bindModel(model, idKey = '_id') {
		let storage = this;

		model.get = function (id) {
			return storage.getByID(model, id);
		};
		model.find = function (filters) {
			return storage.find(model, filters);
		};
		model.clear = async function (filters = {}) {
			let result = await storage.clear(model, filters, true);
			return (result.deletedCount > 0);
		};

		model.prototype.save = async function () {
			try {
				let result = await storage.save(model, Object.assign({}, this));
				if (result[idKey] != undefined) {
					Object.assign(this, result);
				}
				return this;
			} catch (err) {
				throw err;
			}
		};
		model.prototype.remove = async function () {
			let result = await storage.remove(model, this[idKey], true);
			return (result.deletedCount == 1);
		};

		return model;
	}

	combineFilters(filters = []) {
		if (filters['length'] === undefined) filters = [filters];		
		return Object.assign({}, ...filters);
	}

	error(code) {
		return new Error(code);
	}
	getModel(model) {
		return {
			name: model.name.toLowerCase(),
			cls: model
		};
	}
	getNewID(name) {
		return new ObjectID();
	}

	save(model, data) {
		return new Promise((resolve, reject) => {
			model = this.getModel(model);
			const collection = this.db.collection(model.name);
			if (!data._id) {
				//insert
	            collection.insertOne(data).then(result => {
	            	if (result.result.n == 1 && result.ops.length == 1) {
		              resolve(result.ops.pop());
		            } else reject(this.error("NOT_SAVED"));
	            }).catch(err => {
					reject(err);
	            });
			} else {
				//update
				collection.findOne({ _id : new ObjectID(data._id) }).then(item => {
					if (!item) return reject(this.error("NOT_FOUND"));
					let patch = Object.assign({}, Object.keys(data).reduce((a, c) => { if (c !== '_id') { a[c] = data[c]; } return a; }, {}), {
						_updated: new Date()
					});
					collection.updateOne({
						_id: new ObjectID(data._id)
					}, {
						$set: patch
					}).then(result => {
						if (result.matchedCount == result.modifiedCount && result.modifiedCount == 1) {
							resolve(data);
						} else {
							resolve({
								_id: data._id
							});
						}
					}).catch(error => {
						reject(error);
					})
				}).catch(error => {
					reject(error);
				});
			}
		});
	}
	remove(model, id, isFinal) {
		model = this.getModel(model);

		const collection = this.db.collection(model.name);
      	return collection.deleteOne({ _id : new ObjectID(id) });
	}
	find(model, filters) {
		return new Promise((resolve, reject) => {
			model = this.getModel(model);
			let filter = this.combineFilters(filters);
			const collection = this.db.collection(model.name);

			const getAll = async function () {
				let items = await collection.find(filter).toArray();
				return items.map(item => new model.cls(item));
			};
			const getPage = async function (page, limit) {
				let items = await collection
						.find(filter)
						.skip((page - 1) * limit)
						.limit(limit)
						.toArray();
				return items.map(item => new model.cls(item));
			};
			const each = async function* (count, limit) {
				for (let curPage = 1; curPage <= Math.ceil(count / 10); curPage++) {
					let items = await getPage(curPage, limit);
					for (let item of items) {
						yield item;
					}
				}
			};

			collection.countDocuments(filter).then(count => {
				resolve({
					count,
					getAll,
					getPage,
					each
				});
          	});
		});
	}
	getByID(model, id) {
		return new Promise((resolve, reject) => {
			model = this.getModel(model);

			const collection = this.db.collection(model.name);

	      	return collection.findOne({ _id : new ObjectID(id) }).then(item => resolve(item ? (new model.cls(item)) : null));
  		});
	}
	clear(model, filters, isFinal) {
		model = this.getModel(model);
		let filter = this.combineFilters(filters);

		const collection = this.db.collection(model.name);
		return collection.deleteMany(filter);	
	}

	static async init(settings = {}, models = []) {
		let tdb = new TingoDB(settings);

		let db = await tdb.connect();

		for (let model of models) db.bindModel(model);

		return db;
	}
}

module.exports = {
	TingoDB,
	ObjectID
};