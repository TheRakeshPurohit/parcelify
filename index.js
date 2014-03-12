var path = require('path');
var browserify = require( 'browserify' );
var watchify = require( 'watchify' );
var parcelMap = require( 'parcel-map' );
var shasum = require( 'shasum' );
var through2 = require( 'through2' );
var path = require( 'path' );
var _ = require( 'underscore' );
var async = require( 'async' );
var glob = require( 'glob' );
var resolve = require( 'resolve' );
var Package = require( './lib/package' );
var Parcel = require( './lib/parcel' );
var resolve = require( 'resolve' );

var EventEmitter = require('events').EventEmitter;
var Package = require('./lib/package.js');

module.exports = function( mainPath, options, callback ) {
	if( arguments.length === 2 ) {
		// options argument is optional
		callback = options;
		options = {};
	}

	options = _.defaults( {}, options, {
		bundles : {
			script : 'bundle.js',
			style : 'bundle.css',
			template : 'bundle.tmpl'
		},

		watch : false,
		packageTransform : undefined,
		browserifyInstance : undefined,

		// used internally or in order to share packages between multiple parcelify instances
		existingPackages : undefined,

		// whether browserify should create source maps
		debug : false
	} );

	var thisParcel;
	var browerifyInstance = options.browserifyInstance || ( options.watch ? watchify( mainPath ) : browserify( mainPath ) );
	var existingPackages = options.existingPackages || {};

	if( options.watch ) {
		browerifyInstance.on( 'update', _.debounce( function( changedMains ) {
			if( _.contains( changedMains, thisParcel.mainPath ) ) { // I think this should always be the case
				var newOptions = _.clone( options );
				newOptions.existingPackages = existingPackages;

				processParcel( thisParcel.mainPath, browerifyInstance, newOptions, function( err, parcel, packagesCreated ) {
					thisParcel = parcel;
					_.extend( existingPackages, packagesCreated );
				} );
			}
		}, 1000, true ) );
	}

	processParcel( mainPath, browerifyInstance, options, function( err, parcel, packagesCreated ) {
		thisParcel = parcel;
		_.extend( existingPackages, packagesCreated );

		callback( err, parcel );
	} );
};

function processParcel( mainPath, browerifyInstance, options, callback ) {
	var jsBundleStream;

	var existingPackages = options.existingPackages || {};
	var assetTypes = _.without( Object.keys( options.bundles ), 'script' );

	parcelMap( browerifyInstance, { keys : assetTypes }, function( err, parcelMap ) {
		if( err ) return callback( err );
		
		instantiateParcelAndPackagesFromMap( mainPath, parcelMap, existingPackages, assetTypes, function( err, thisParcel, packagesThatWereCreated ) {
			if( err ) return callback( err );

			thisParcel.setJsBundleStream( jsBundleStream );

			process.nextTick( function() {
				async.series( [ function( nextSeries ) {
					// fire package events for any new packages
					_.each( packagesThatWereCreated, function( thisPackage ) { thisParcel.emit( 'package', thisPackage ); } );

					nextSeries();
				}, function( nextSeries ) {
					// we are done copying packages and collecting our asset streams. Now write our bundles to disk.
					thisParcel.writeBundles( options.bundles, nextSeries );
				}, function( nextSeries ) {
					var thisParcelIsNew = _.contains( packagesThatWereCreated, thisParcel );

					if( options.watch ) {
						// we only create glob watchers for the packages that parcel added to the manifest. Again, we want to avoid doubling up
						// work in situations where we have multiple parcelify instances running that share common bundles
						_.each( packagesThatWereCreated, function( thisPackage ) { thisPackage.createWatchers( assetTypes ); } );
						if( thisParcelIsNew ) thisParcel.attachWatchListeners( options.bundles );
					}

					if( thisParcelIsNew ) thisParcel.emit( 'done' );

					nextSeries();
				} ] );
			} );

			return callback( null, thisParcel, packagesThatWereCreated ); // return this parcel to our calling function via the cb
		} );
	} );
	
	// get things moving. note we need to do this after parcelMap has been called with the browserify instance
	jsBundleStream = browerifyInstance.bundle( {
		packageFilter : options.packageTransform,
		debug : options.debug
	} ).pipe( through2() );
}

function instantiateParcelAndPackagesFromMap( mainPath, parcelMap, existingPacakages, assetTypes, callback ) {
	var mappedParcel = null;
	var packagesThatWereCreated = {};
	var pathOfMappedParcel = path.dirname( mainPath );
	var thisIsTheTopLevelParcel;

	async.series( [ function( nextSeries ) {
		async.each( Object.keys( parcelMap.packages ), function( thisPackageId, nextPackageId ) {
			var packageOptions = {};

			async.waterfall( [ function( nextWaterfall ) {
				var packageJson = parcelMap.packages[ thisPackageId ];
				Package.getOptionsFromPackageJson( thisPackageId, packageJson.__dirname, packageJson, assetTypes, nextWaterfall );
			}, function( packageOptions, nextWaterfall ) {
				var thisPackage;

				thisIsTheTopLevelParcel = packageOptions.path === pathOfMappedParcel;

				if( ! existingPacakages[ thisPackageId ] ) {
					if( packageOptions.isParcel ) {
						if( thisIsTheTopLevelParcel ) {
							packageOptions.mainPath = mainPath;
						}

						thisPackage = packagesThatWereCreated[ thisPackageId ] = new Parcel( packageOptions );
					}
					else thisPackage = packagesThatWereCreated[ thisPackageId ] = new Package( packageOptions );

					thisPackage.createAllAssets( assetTypes );
				}
				else
					thisPackage = existingPacakages[ thisPackageId ];

				if( thisIsTheTopLevelParcel ) mappedParcel = thisPackage;

				nextWaterfall();
			} ], nextPackageId );
		}, nextSeries );
	}, function( nextSeries ) {
		if( ! mappedParcel ) return callback( new Error( 'Could not locate this mapped parcel id.' ) );

		var allPackagesRelevantToThisParcel = _.extend( existingPacakages, packagesThatWereCreated );

		// now that we have all our packages instantiated, hook up dependencies
		_.each( parcelMap.dependencies, function( dependencyIds, thisPackageId ) {
			var thisPackage = allPackagesRelevantToThisParcel[ thisPackageId ];
			var thisPackageDependencies = _.map( dependencyIds, function( thisDependencyId ) { return allPackagesRelevantToThisParcel[ thisDependencyId ]; } );
			thisPackage.setDependencies( thisPackageDependencies );
		} );

		_.each( allPackagesRelevantToThisParcel, function( thisPackage ) {
			if( thisPackage === mappedParcel ) return; // debatable whether or not it makes sense semantically to include a parcel as a dependent of itself.

			thisPackage.addDependentParcel( mappedParcel );
		} );

		// finally, we can calculate the topo sort of all the dependencies and assets in the parcel
		mappedParcel.calcSortedDependencies();
		mappedParcel.calcParcelAssets( assetTypes );

		nextSeries();
	} ], function( err ) {
		return callback( err, mappedParcel, packagesThatWereCreated );
	} );
}
